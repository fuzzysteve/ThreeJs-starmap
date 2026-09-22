// WebGPU renderer for gpusystem.js.
//
// A solar system spans ~1e13m while a station is ~1e4m, far beyond what
// float32 can hold in one coordinate frame. So nothing is ever uploaded in
// system coordinates: the caller works in float64 and hands over positions
// already made relative to the camera (float32 is then precise exactly
// where it matters - near the eye). The view matrix is rotation-only.
//
// Depth is reversed-Z with an infinite far plane, so a 1m near plane and
// objects 1e13m away share one depth32float buffer without fighting.
//
// Bodies are ray-traced sphere impostors rather than meshes: a camera-
// facing quad (or a full-screen triangle pair when very close) whose
// fragment shader intersects the ray with the sphere and writes the true
// depth. That gives a perfect silhouette at any scale - no tessellation
// LOD to pop between, and no faceting when skimming a planet's surface.
//
// Four passes, all into one 4x MSAA target:
//   spheres  - opaque impostors, writes depth, alpha-to-coverage edges
//   meshes   - real triangle geometry for small objects (station
//              dodecahedra, asteroid-belt rocks), instanced per mesh
//   lines    - orbit rings, depth-tested, blended
//   markers  - screen-space sprites (LOD stand-ins, sun glow, sky stars,
//              selection brackets), depth-tested, premultiplied blending
//              (alpha 0 = purely additive)

export const SPHERE_FLOATS = 16;
export const MARKER_FLOATS = 12;
export const LINE_FLOATS = 8;
export const MESH_FLOATS = 16;
export const MESH_STYLE = { ROCK: 0, STATION: 1, GATE: 2 };
// stargate torus proportions (circumradius 1); the shader needs the major
// radius to tell the inner rim from the outer
export const GATE_RING = { major: 0.86, minor: 0.14 };

export const SHAPE = {
    DOT: 0, RING: 1, DIAMOND: 2, SQUARE: 3, TRIANGLE: 4, CROSS: 5, BRACKET: 6, GLOW: 7, STAR: 8
};

const COMMON_WGSL = /* wgsl */`
struct Frame {
    proj : mat4x4f,
    viewRot : mat4x4f,
    invViewRot : mat4x4f,
    viewport : vec4f,   // width, height, 1/width, 1/height
    params : vec4f,     // tanHalfFovY, aspect, near, time
    sh0 : vec4f,        // sky irradiance as 9 L2 spherical-harmonic
    sh1 : vec4f,        // coefficients (sh0.xyzw, sh1.xyzw, sh2.x),
    sh2 : vec4f,        // normalised so the sphere-average irradiance is 1
    skyLight : vec4f,   // rgb tint * strength, w = ambient floor
    sunRel : vec4f,     // star centre, camera-relative, world axes
};
@group(0) @binding(0) var<uniform> frame : Frame;

// Ramamoorthi & Hanrahan irradiance from L2 SH - the sky's light arriving
// on a surface facing n. Star-dense directions (the galactic band) come
// out brighter than empty sky, so the night side isn't uniformly flat
fn skyIrradiance(n : vec3f) -> vec3f {
    let c1 = 0.429043; let c2 = 0.511664; let c3 = 0.743125; let c4 = 0.886227; let c5 = 0.247708;
    let L00 = frame.sh0.x; let L1m1 = frame.sh0.y; let L10 = frame.sh0.z; let L11 = frame.sh0.w;
    let L2m2 = frame.sh1.x; let L2m1 = frame.sh1.y; let L20 = frame.sh1.z; let L21 = frame.sh1.w;
    let L22 = frame.sh2.x;
    let e = c1 * L22 * (n.x * n.x - n.y * n.y) + c3 * L20 * n.z * n.z + c4 * L00 - c5 * L20
        + 2.0 * c1 * (L2m2 * n.x * n.y + L21 * n.x * n.z + L2m1 * n.y * n.z)
        + 2.0 * c2 * (L11 * n.x + L1m1 * n.y + L10 * n.z);
    let floorLevel = frame.skyLight.w;
    return frame.skyLight.rgb * (floorLevel + (1.0 - floorLevel) * max(e, 0.0));
}

fn hash3(p : vec3f) -> f32 {
    var q = fract(p * 0.3183099 + vec3f(0.71, 0.113, 0.419));
    q *= 17.0;
    return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}

fn vnoise(p : vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i + vec3f(0,0,0)), hash3(i + vec3f(1,0,0)), u.x),
                   mix(hash3(i + vec3f(0,1,0)), hash3(i + vec3f(1,1,0)), u.x), u.y),
               mix(mix(hash3(i + vec3f(0,0,1)), hash3(i + vec3f(1,0,1)), u.x),
                   mix(hash3(i + vec3f(0,1,1)), hash3(i + vec3f(1,1,1)), u.x), u.y), u.z);
}

// octave count comes from the CPU and scales with on-screen size: a
// 3px moon gets one octave, a planet filling the screen gets eight
fn fbm(p : vec3f, octaves : i32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    var norm = 0.0;
    for (var o = 0; o < 8; o++) {
        if (o >= octaves) { break; }
        sum += vnoise(q) * amp;
        norm += amp;
        amp *= 0.5;
        q = q * 2.03 + vec3f(1.7, 9.2, 3.1);
    }
    return sum / max(norm, 1e-4);
}
`;

const SPHERE_WGSL = COMMON_WGSL + /* wgsl */`
struct Sphere {
    center : vec3f,     // camera-relative, world axes
    radius : f32,
    color : vec3f,
    kind : f32,         // surface style, see shade()
    sunDir : vec3f,     // world axes, unit vector from body to star
    seed : f32,
    params : vec4f,     // x: noise octaves (shading LOD), y: fullscreen, z: highlight, w: atmosphere
};
@group(1) @binding(0) var<storage, read> spheres : array<Sphere>;

struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) ray : vec3f,
    @location(1) @interpolate(flat) idx : u32,
};


@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
    let s = spheres[ii];
    var corners = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
    );
    let corner = corners[vi];
    var out : VOut;
    out.idx = ii;

    if (s.params.y > 0.5) {
        // camera is close enough that a billboard could poke behind the
        // eye - just cover the whole screen and let the ray test decide
        out.pos = vec4f(corner, 0.5, 1.0);
        out.ray = vec3f(corner.x * frame.params.x * frame.params.y, corner.y * frame.params.x, -1.0);
        return out;
    }

    let c = (frame.viewRot * vec4f(s.center, 0.0)).xyz;
    let d = length(c);
    let dir = c / d;
    // half-size of the tangent cone's cross-section at the centre's
    // distance - bounds the silhouette exactly, however far off-axis
    let half = s.radius * d / sqrt(max(d * d - s.radius * s.radius, 1e-6)) * 1.05;
    var up = vec3f(0.0, 1.0, 0.0);
    if (abs(dir.y) > 0.99) { up = vec3f(1.0, 0.0, 0.0); }
    let right = normalize(cross(dir, up));
    let up2 = cross(right, dir);
    let p = c + (right * corner.x + up2 * corner.y) * half;
    // clip space is homogeneous, so scaling every corner by the same 1/d
    // changes nothing geometrically - but it keeps w near 1 instead of
    // ~1e13, which some rasterisers can't perspective-interpolate cleanly
    out.pos = frame.proj * vec4f(p, 1.0) / d;
    out.ray = p / d;
    return out;
}

struct Surface {
    albedo : vec3f,
    emissive : vec3f,
    atmosphere : vec3f,
};

fn shade(kind : i32, n : vec3f, base : vec3f, seed : f32, oct : i32) -> Surface {
    var s : Surface;
    s.albedo = base;
    s.emissive = vec3f(0.0);
    s.atmosphere = vec3f(0.0);
    let p = n * 2.0 + vec3f(seed * 13.1, seed * 7.3, seed * 3.7);
    let t = frame.params.w;

    switch kind {
        case 0: { // star - granulation plus limb darkening applied by caller
            let g = fbm(p * 4.0 + vec3f(0.0, t * 0.02, 0.0), oct);
            s.emissive = base * (1.0 + 0.6 * g);
        }
        case 1: { // gas giant - latitude bands warped by noise
            let w = fbm(p * 1.5, oct);
            let band = sin(n.y * 18.0 + w * 5.0 + seed * 10.0);
            let band2 = sin(n.y * 43.0 + w * 3.0);
            s.albedo = base * (0.75 + 0.2 * band + 0.1 * band2);
            s.atmosphere = base * 0.6 + vec3f(0.1);
        }
        case 2: { // barren - pitted grey/brown
            let h = fbm(p * 3.0, oct);
            let crater = smoothstep(0.55, 0.75, fbm(p * 7.0 + vec3f(3.0), max(oct - 1, 1)));
            s.albedo = base * (0.55 + 0.6 * h) * (1.0 - 0.35 * crater);
        }
        case 3: { // temperate - land, ocean, cloud
            let h = fbm(p * 2.5, oct);
            let land = smoothstep(0.48, 0.52, h);
            let ocean = vec3f(0.05, 0.16, 0.35);
            let ground = mix(vec3f(0.18, 0.35, 0.12), vec3f(0.45, 0.4, 0.28), smoothstep(0.55, 0.7, h));
            let polar = smoothstep(0.75, 0.9, abs(n.y));
            let cloud = smoothstep(0.55, 0.75, fbm(p * 4.0 + vec3f(t * 0.003), oct));
            s.albedo = mix(mix(ocean, ground, land), vec3f(0.9), max(polar, cloud * 0.8));
            s.atmosphere = vec3f(0.3, 0.55, 1.0);
        }
        case 4: { // lava - dark crust, glowing seams
            let h = fbm(p * 3.0, oct);
            let seam = 1.0 - smoothstep(0.0, 0.06, abs(h - 0.5));
            s.albedo = vec3f(0.12, 0.08, 0.07) * (0.6 + h);
            s.emissive = vec3f(1.0, 0.35, 0.05) * seam * 1.5;
        }
        case 5: { // storm - swirling grey-blue
            let w = fbm(p * 2.0, oct);
            let swirl = fbm(p * 3.0 + vec3f(w * 3.0, n.y * 4.0, 0.0), oct);
            s.albedo = base * (0.55 + 0.6 * swirl);
            s.atmosphere = vec3f(0.4, 0.5, 0.8);
        }
        case 6: { // ice
            let h = fbm(p * 3.0, oct);
            s.albedo = mix(vec3f(0.6, 0.75, 0.9), vec3f(0.95, 0.97, 1.0), h);
            s.atmosphere = vec3f(0.4, 0.6, 0.9) * 0.4;
        }
        case 7: { // oceanic
            let h = fbm(p * 2.5, oct);
            let cloud = smoothstep(0.55, 0.8, fbm(p * 4.0 + vec3f(t * 0.003), oct));
            s.albedo = mix(vec3f(0.03, 0.12, 0.4) * (0.8 + 0.4 * h), vec3f(0.9), cloud * 0.8);
            s.atmosphere = vec3f(0.3, 0.55, 1.0);
        }
        case 8: { // plasma - hot bands, partly self-luminous
            let w = fbm(p * 2.0, oct);
            let band = 0.5 + 0.5 * sin(n.y * 12.0 + w * 8.0);
            s.albedo = base * 0.5;
            s.emissive = base * band * 0.6;
            s.atmosphere = base * 0.5;
        }
        case 9: { // shattered - fractured crust
            let h = fbm(p * 5.0, oct);
            let crack = 1.0 - smoothstep(0.0, 0.03, abs(h - 0.5));
            s.albedo = vec3f(0.35, 0.3, 0.28) * (0.5 + h) * (1.0 - crack * 0.8);
            s.emissive = vec3f(0.9, 0.4, 0.1) * crack * 0.4;
        }
        default: { // moon and anything else - lightly cratered rock
            let h = fbm(p * 3.5, oct);
            s.albedo = base * (0.6 + 0.5 * h);
        }
    }
    return s;
}

struct FOut {
    @location(0) color : vec4f,
    @builtin(frag_depth) depth : f32,
};

@fragment
fn fs(in : VOut) -> FOut {
    let s = spheres[in.idx];
    let dir = normalize(in.ray);
    let oc = (frame.viewRot * vec4f(s.center, 0.0)).xyz;

    // numerically stable ray/sphere: measure the miss distance directly
    // instead of the textbook b*b - c, which cancels to garbage in f32
    // once the sphere is more than a few hundred radii away
    let tca = dot(oc, dir);
    if (tca < 0.0) { discard; }
    let h = oc - tca * dir;
    let h2 = dot(h, h);
    let r2 = s.radius * s.radius;
    if (h2 > r2) { discard; }
    let hitT = tca - sqrt(r2 - h2);
    let hit = dir * hitT;
    let nView = normalize(hit - oc);
    let n = (frame.invViewRot * vec4f(nView, 0.0)).xyz;

    // coverage at the limb for alpha-to-coverage antialiasing
    let pixelSize = max(hitT, 1.0) * 2.0 * frame.params.x * frame.viewport.w;
    let edge = clamp((s.radius - sqrt(h2)) / pixelSize + 0.5, 0.0, 1.0);

    let kind = i32(s.kind + 0.5);
    let oct = i32(s.params.x + 0.5);
    let surf = shade(kind, n, s.color, s.seed, oct);
    let viewCos = clamp(dot(nView, -dir), 0.0, 1.0);

    var col : vec3f;
    if (kind == 0) {
        let limb = 0.35 + 0.65 * pow(viewCos, 0.5);
        col = surf.emissive * limb;
    } else {
        let lambert = max(dot(n, s.sunDir), 0.0);
        let terminator = smoothstep(-0.1, 0.25, dot(n, s.sunDir));
        col = surf.albedo * (lambert * 1.1 + skyIrradiance(n)) + surf.emissive;
        let rim = pow(1.0 - viewCos, 3.0);
        col += surf.atmosphere * rim * s.params.w * terminator * 0.9;
    }
    if (s.params.z > 0.5) {
        col += vec3f(0.25, 0.4, 0.5) * pow(1.0 - viewCos, 4.0);
    }

    // exponential exposure so the star and lit limbs roll off (keeping
    // their colour) instead of clipping to flat white
    col = vec3f(1.0) - exp(-col * 1.6);

    var out : FOut;
    out.color = vec4f(col, edge);
    let viewZ = max(-hit.z, frame.params.z);
    out.depth = clamp(frame.params.z / viewZ, 0.0, 1.0);
    return out;
}
`;

const MARKER_WGSL = COMMON_WGSL + /* wgsl */`
struct Marker {
    center : vec3f,     // camera-relative, world axes
    sizePx : f32,
    color : vec4f,      // premultiplied at the end; a = 0 makes it additive
    shape : f32,
    alpha : f32,
    pad0 : f32,
    pad1 : f32,
};
@group(1) @binding(0) var<storage, read> markers : array<Marker>;

struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) uv : vec2f,
    @location(1) @interpolate(flat) idx : u32,
};


@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
    let m = markers[ii];
    var corners = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
    );
    let corner = corners[vi];
    var clip = frame.proj * (frame.viewRot * vec4f(m.center, 1.0));
    // markers are only ever emitted for points in front of the camera,
    // but guard anyway so a stray one can't smear across the screen
    if (clip.w <= 0.0) { clip = vec4f(0.0, 0.0, -1.0, 1.0); }
    // divide through here: sky stars sit at w ~ 1e20, far outside what
    // perspective-correct interpolation of uv tolerates. A flat sprite
    // doesn't need perspective interpolation anyway
    clip = clip / clip.w;
    clip = vec4f(clip.xy + corner * m.sizePx * frame.viewport.zw * 2.0, clip.z, 1.0);
    var out : VOut;
    out.pos = clip;
    out.uv = corner;
    out.idx = ii;
    return out;
}

fn sdBox(p : vec2f, b : vec2f) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
    let m = markers[in.idx];
    let shape = i32(m.shape + 0.5);
    let p = in.uv;
    // one pixel expressed in uv units, for crisp 1px-wide strokes
    let px = 1.0 / max(m.sizePx, 1.0);
    let stroke = 1.2 * px;
    var a = 0.0;

    switch shape {
        case 0: { // filled dot
            a = 1.0 - smoothstep(1.0 - 2.0 * px, 1.0, length(p));
        }
        case 1: { // ring
            a = 1.0 - smoothstep(0.0, stroke, abs(length(p) - (1.0 - 2.0 * px)) - stroke * 0.5);
            a = max(a, 1.0 - smoothstep(0.0, px, length(p) - 0.8 * px));
        }
        case 2: { // diamond outline
            let d = abs(p.x) + abs(p.y);
            a = 1.0 - smoothstep(0.0, stroke, abs(d - (1.0 - 2.0 * px)) - stroke * 0.5);
        }
        case 3: { // square outline
            let d = sdBox(p, vec2f(1.0 - 2.0 * px));
            a = 1.0 - smoothstep(0.0, stroke, abs(d) - stroke * 0.5);
        }
        case 4: { // triangle outline
            let q = vec2f(abs(p.x), p.y + 0.3);
            let d = max(q.x * 0.866 + q.y * 0.5, -q.y) - 0.6;
            a = 1.0 - smoothstep(0.0, stroke, abs(d) - stroke * 0.5);
        }
        case 5: { // plus
            let d = min(sdBox(p, vec2f(1.0, stroke * 0.6)), sdBox(p, vec2f(stroke * 0.6, 1.0)));
            a = 1.0 - smoothstep(0.0, px, d);
        }
        case 6: { // selection bracket - four corners only
            let d = abs(sdBox(p, vec2f(1.0 - 2.0 * px))) - stroke * 0.5;
            let corners = step(0.55, abs(p.x)) * step(0.55, abs(p.y));
            a = (1.0 - smoothstep(0.0, stroke, d)) * corners;
        }
        case 7: { // soft glow
            let r = length(p);
            a = exp(-r * r * 80.0) + 0.45 * pow(max(1.0 - r, 0.0), 4.0);
        }
        default: { // background star - gaussian point
            let r2 = dot(p, p);
            a = exp(-r2 * 6.0);
        }
    }

    a *= m.alpha;
    if (a <= 0.002) { discard; }
    // premultiplied output; color.a scales how much it occludes, so
    // color.a = 0 gives purely additive light (glows, stars)
    return vec4f(m.color.rgb * a, a * m.color.a);
}
`;

const MESH_WGSL = COMMON_WGSL + /* wgsl */`
struct MeshInst {
    center : vec3f,     // camera-relative, world axes
    scale : f32,        // circumradius in metres
    rot : vec4f,        // orientation quaternion
    stretch : vec3f,    // per-axis squash, applied before rotation
    seed : f32,
    color : vec3f,
    style : f32,        // 0 rock, 1 station, 2 stargate (color = glow tint)
};
@group(1) @binding(0) var<storage, read> meshes : array<MeshInst>;

struct VIn {
    @location(0) pos : vec3f,
    @location(1) normal : vec3f,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) normal : vec3f,
    @location(1) obj : vec3f,
    @location(2) world : vec3f,
    @location(3) @interpolate(flat) idx : u32,
};

fn qrot(q : vec4f, v : vec3f) -> vec3f {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs(in : VIn, @builtin(instance_index) ii : u32) -> VOut {
    let m = meshes[ii];
    let world = m.center + qrot(m.rot, in.pos * m.stretch) * m.scale;
    var out : VOut;
    out.pos = frame.proj * (frame.viewRot * vec4f(world, 1.0));
    out.normal = qrot(m.rot, in.normal / m.stretch);
    out.obj = in.pos;
    out.world = world;
    out.idx = ii;
    return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
    let m = meshes[in.idx];
    let n = normalize(in.normal);
    let sunDir = normalize(frame.sunRel.xyz - in.world);
    let sunCos = dot(n, sunDir);
    let lambert = max(sunCos, 0.0);

    var albedo : vec3f;
    var emissive = vec3f(0.0);
    if (m.style > 1.5) {
        // stargate ring: banded metal, the inner rim lit in the colour of
        // the destination's security, running lights round the outer edge
        let major = 0.86;
        let radial = length(in.obj.xy);
        let around = atan2(in.obj.y, in.obj.x) / 6.2831853 + 0.5;
        let tube = atan2(in.obj.z, radial - major);
        let band = step(0.5, fract(around * 36.0)) * 0.12 + step(0.92, fract(around * 6.0)) * -0.2;
        albedo = vec3f(0.47, 0.45, 0.42) * (0.8 + band + 0.15 * vnoise(in.obj * 25.0));
        let inner = smoothstep(0.3, 0.95, -cos(tube));
        let beacon = (1.0 - smoothstep(0.0, 0.03, abs(fract(around * 8.0) - 0.5))) * smoothstep(0.85, 0.97, cos(tube));
        emissive = m.color * inner * 0.8 + vec3f(1.0, 0.9, 0.7) * beacon * 1.5;
    } else if (m.style > 0.5) {
        // station: panelled plating, window lights that show on the dark side
        let q = in.obj * 9.0;
        let panel = step(0.5, fract(q.x + 0.5 * step(0.5, fract(q.y)))) * 0.08
                  + step(0.94, fract(q.y * 2.0)) * -0.12;
        albedo = m.color * (0.85 + panel + 0.15 * vnoise(in.obj * 30.0 + m.seed * 40.0));
        let cell = floor(in.obj * 26.0 + vec3f(m.seed * 50.0));
        let lit = step(0.9, hash3(cell));
        let night = 1.0 - smoothstep(-0.05, 0.3, sunCos);
        emissive = vec3f(1.0, 0.82, 0.55) * lit * (0.25 + 0.75 * night) * 0.9;
    } else {
        // rock: mottled, a little darker in the crevices
        let h = fbm(in.obj * 3.0 + vec3f(m.seed * 23.0), 4);
        let fine = vnoise(in.obj * 18.0 + vec3f(m.seed * 7.0));
        albedo = m.color * (0.55 + 0.6 * h + 0.2 * fine);
    }

    var col = albedo * (lambert * 1.1 + skyIrradiance(n)) + emissive;
    col = vec3f(1.0) - exp(-col * 1.6);
    return vec4f(col, 1.0);
}
`;

const LINE_WGSL = COMMON_WGSL + /* wgsl */`
struct VIn {
    @location(0) pos : vec3f,
    @location(1) alpha : f32,
    @location(2) color : vec4f,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) color : vec4f,
};
@vertex
fn vs(in : VIn) -> VOut {
    var out : VOut;
    out.pos = frame.proj * (frame.viewRot * vec4f(in.pos, 1.0));
    out.color = vec4f(in.color.rgb * in.alpha, in.alpha * in.color.a);
    return out;
}
@fragment
fn fs(in : VOut) -> @location(0) vec4f {
    return in.color;
}
`;

const SAMPLES = 4;

const PREMULTIPLIED_BLEND = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
};

// A growable storage buffer plus the bind group pointing at it
class InstanceBuffer {
    constructor( device, layout, floatsPerInstance, label ) {
        this.device = device;
        this.layout = layout;
        this.floatsPerInstance = floatsPerInstance;
        this.label = label;
        this.capacity = 0;
        this.count = 0;
        this.ensure( 64 );
    }

    ensure( count ) {
        if ( count <= this.capacity ) return;
        var cap = Math.max( 64, this.capacity );
        while ( cap < count ) cap *= 2;
        if ( this.buffer ) this.buffer.destroy();
        this.capacity = cap;
        this.data = new Float32Array( cap * this.floatsPerInstance );
        this.buffer = this.device.createBuffer( {
            label: this.label,
            size: this.data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        } );
        this.bindGroup = this.device.createBindGroup( {
            layout: this.layout,
            entries: [ { binding: 0, resource: { buffer: this.buffer } } ]
        } );
    }

    upload( data, count ) {
        this.ensure( count );
        this.count = count;
        if ( count > 0 ) {
            this.device.queue.writeBuffer( this.buffer, 0, data, 0, count * this.floatsPerInstance );
        }
    }
}

export class Renderer {

    static async create( canvas ) {
        if ( !navigator.gpu ) throw new Error( 'This browser does not support WebGPU.' );
        var adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
        if ( !adapter ) throw new Error( 'No suitable GPU adapter was found.' );
        var device = await adapter.requestDevice();
        var r = new Renderer( canvas, device );
        return r;
    }

    constructor( canvas, device ) {
        this.canvas = canvas;
        this.device = device;
        this.context = canvas.getContext( 'webgpu' );
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure( { device: device, format: this.format, alphaMode: 'opaque' } );
        this.lost = false;
        device.lost.then( ( info ) => {
            this.lost = true;
            console.error( 'WebGPU device lost:', info.message );
        } );

        this.frameBuffer = device.createBuffer( {
            size: 4 * ( 16 * 3 + 28 ),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        } );
        this.frameData = new Float32Array( 16 * 3 + 28 );
        this.sunRel = [ 0, 0, 0 ];
        // flat sky until the caller supplies a real one
        this.skySH = new Float32Array( [ 1 / 0.886227, 0, 0, 0, 0, 0, 0, 0, 0 ] );
        this.skyLight = [ 0.1, 0.11, 0.14, 1 ];

        this.frameLayout = device.createBindGroupLayout( { entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
        ] } );
        this.instanceLayout = device.createBindGroupLayout( { entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
        ] } );
        this.frameBindGroup = device.createBindGroup( {
            layout: this.frameLayout,
            entries: [ { binding: 0, resource: { buffer: this.frameBuffer } } ]
        } );

        var instancedLayout = device.createPipelineLayout( { bindGroupLayouts: [ this.frameLayout, this.instanceLayout ] } );
        var frameOnlyLayout = device.createPipelineLayout( { bindGroupLayouts: [ this.frameLayout ] } );

        var sphereModule = device.createShaderModule( { label: 'spheres', code: SPHERE_WGSL } );
        var markerModule = device.createShaderModule( { label: 'markers', code: MARKER_WGSL } );
        var lineModule = device.createShaderModule( { label: 'lines', code: LINE_WGSL } );
        var meshModule = device.createShaderModule( { label: 'meshes', code: MESH_WGSL } );

        this.spherePipeline = device.createRenderPipeline( {
            label: 'spheres',
            layout: instancedLayout,
            vertex: { module: sphereModule, entryPoint: 'vs' },
            fragment: { module: sphereModule, entryPoint: 'fs', targets: [ { format: this.format } ] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: SAMPLES, alphaToCoverageEnabled: true }
        } );

        this.meshPipeline = device.createRenderPipeline( {
            label: 'meshes',
            layout: instancedLayout,
            vertex: {
                module: meshModule, entryPoint: 'vs',
                buffers: [ {
                    arrayStride: 24,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' }
                    ]
                } ]
            },
            fragment: { module: meshModule, entryPoint: 'fs', targets: [ { format: this.format } ] },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: SAMPLES }
        } );

        this.linePipeline = device.createRenderPipeline( {
            label: 'lines',
            layout: frameOnlyLayout,
            vertex: {
                module: lineModule, entryPoint: 'vs',
                buffers: [ {
                    arrayStride: LINE_FLOATS * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32' },
                        { shaderLocation: 2, offset: 16, format: 'float32x4' }
                    ]
                } ]
            },
            fragment: { module: lineModule, entryPoint: 'fs', targets: [ { format: this.format, blend: PREMULTIPLIED_BLEND } ] },
            primitive: { topology: 'line-list' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
            multisample: { count: SAMPLES }
        } );

        var markerDesc = function ( compare ) {
            return {
                label: 'markers-' + compare,
                layout: instancedLayout,
                vertex: { module: markerModule, entryPoint: 'vs' },
                fragment: { module: markerModule, entryPoint: 'fs', targets: [ { format: this.format, blend: PREMULTIPLIED_BLEND } ] },
                primitive: { topology: 'triangle-list' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: compare },
                multisample: { count: SAMPLES }
            };
        }.bind( this );
        this.markerPipeline = device.createRenderPipeline( markerDesc( 'greater-equal' ) );
        // selection brackets and hover rings draw on top of everything
        this.overlayPipeline = device.createRenderPipeline( markerDesc( 'always' ) );

        this.spheres = new InstanceBuffer( device, this.instanceLayout, SPHERE_FLOATS, 'sphere instances' );
        this.markers = new InstanceBuffer( device, this.instanceLayout, MARKER_FLOATS, 'marker instances' );
        this.overlay = new InstanceBuffer( device, this.instanceLayout, MARKER_FLOATS, 'overlay instances' );
        this.sky = new InstanceBuffer( device, this.instanceLayout, MARKER_FLOATS, 'sky instances' );
        this.meshes = new InstanceBuffer( device, this.instanceLayout, MESH_FLOATS, 'mesh instances' );
        this.meshDraws = [];

        this.lineCapacity = 0;
        this.lineCount = 0;
        this.ensureLines( 4096 );

        this.width = 0;
        this.height = 0;
    }

    ensureLines( count ) {
        if ( count <= this.lineCapacity ) return;
        var cap = Math.max( 4096, this.lineCapacity );
        while ( cap < count ) cap *= 2;
        if ( this.lineBuffer ) this.lineBuffer.destroy();
        this.lineCapacity = cap;
        this.lineBuffer = this.device.createBuffer( {
            label: 'orbit lines',
            size: cap * LINE_FLOATS * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        } );
    }

    resize( width, height ) {
        width = Math.max( 1, Math.floor( width ) );
        height = Math.max( 1, Math.floor( height ) );
        if ( width === this.width && height === this.height ) return;
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
        if ( this.msaaTexture ) this.msaaTexture.destroy();
        if ( this.depthTexture ) this.depthTexture.destroy();
        this.msaaTexture = this.device.createTexture( {
            size: [ width, height ], format: this.format, sampleCount: SAMPLES,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        } );
        this.depthTexture = this.device.createTexture( {
            size: [ width, height ], format: 'depth32float', sampleCount: SAMPLES,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        } );
    }

    // viewRot is a column-major 3x3 (Float64Array(9)) world->view rotation
    setFrame( viewRot, fovY, near, time ) {
        var f = this.frameData;
        var aspect = this.width / this.height;
        var tanHalf = Math.tan( fovY / 2 );
        var focal = 1 / tanHalf;

        f.fill( 0 );
        // reversed-Z, infinite far: depth = near / -z_view
        f[ 0 ] = focal / aspect;
        f[ 5 ] = focal;
        f[ 11 ] = -1;
        f[ 14 ] = near;

        for ( var c = 0; c < 3; c++ ) {
            for ( var r = 0; r < 3; r++ ) {
                f[ 16 + c * 4 + r ] = viewRot[ c * 3 + r ];
                // the transpose is the inverse for a pure rotation
                f[ 32 + c * 4 + r ] = viewRot[ r * 3 + c ];
            }
        }
        f[ 31 ] = 1;
        f[ 47 ] = 1;

        f[ 48 ] = this.width;
        f[ 49 ] = this.height;
        f[ 50 ] = 1 / this.width;
        f[ 51 ] = 1 / this.height;
        f[ 52 ] = tanHalf;
        f[ 53 ] = aspect;
        f[ 54 ] = near;
        f[ 55 ] = time;
        for ( var k = 0; k < 9; k++ ) f[ 56 + k ] = this.skySH[ k ];
        f[ 68 ] = this.skyLight[ 0 ];
        f[ 69 ] = this.skyLight[ 1 ];
        f[ 70 ] = this.skyLight[ 2 ];
        f[ 71 ] = this.skyLight[ 3 ];
        f[ 72 ] = this.sunRel[ 0 ];
        f[ 73 ] = this.sunRel[ 1 ];
        f[ 74 ] = this.sunRel[ 2 ];
        this.device.queue.writeBuffer( this.frameBuffer, 0, f );
    }

    setSky( data, count ) { this.sky.upload( data, count ); }

    // sh: 9 SH coefficients (L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22)
    // tint: rgb already multiplied by strength; floor: fraction of the
    // ambient that is direction-independent
    setSkyLight( sh, tint, floor ) {
        this.skySH.set( sh );
        this.skyLight = [ tint[ 0 ], tint[ 1 ], tint[ 2 ], floor ];
    }
    setSpheres( data, count ) { this.spheres.upload( data, count ); }

    // star position relative to the camera, for lighting meshes
    setSun( rel ) { this.sunRel = rel; }

    // vertices: interleaved position.xyz, normal.xyz, triangle-list with
    // counter-clockwise outward winding
    createMesh( vertices, label ) {
        var buffer = this.device.createBuffer( {
            label: label, size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        } );
        this.device.queue.writeBuffer( buffer, 0, vertices );
        return { buffer: buffer, count: vertices.length / 6 };
    }

    // data: all mesh instances, grouped so each draw is a contiguous run;
    // draws: [{ mesh, first, count }]
    setMeshes( data, count, draws ) {
        this.meshes.upload( data, count );
        this.meshDraws = draws;
    }
    setMarkers( data, count ) { this.markers.upload( data, count ); }
    setOverlay( data, count ) { this.overlay.upload( data, count ); }

    // data holds pairs of vertices (line-list)
    setLines( data, vertexCount ) {
        this.ensureLines( vertexCount );
        this.lineCount = vertexCount;
        if ( vertexCount > 0 ) {
            this.device.queue.writeBuffer( this.lineBuffer, 0, data, 0, vertexCount * LINE_FLOATS );
        }
    }

    render() {
        if ( this.lost ) return;
        var encoder = this.device.createCommandEncoder();
        var pass = encoder.beginRenderPass( {
            colorAttachments: [ {
                view: this.msaaTexture.createView(),
                resolveTarget: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0.004, g: 0.005, b: 0.012, a: 1 },
                loadOp: 'clear',
                storeOp: 'discard'
            } ],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthClearValue: 0,
                depthLoadOp: 'clear',
                depthStoreOp: 'discard'
            }
        } );

        pass.setBindGroup( 0, this.frameBindGroup );

        if ( this.spheres.count > 0 ) {
            pass.setPipeline( this.spherePipeline );
            pass.setBindGroup( 1, this.spheres.bindGroup );
            pass.draw( 6, this.spheres.count );
        }

        if ( this.meshes.count > 0 && this.meshDraws.length ) {
            pass.setPipeline( this.meshPipeline );
            pass.setBindGroup( 1, this.meshes.bindGroup );
            for ( var i = 0; i < this.meshDraws.length; i++ ) {
                var d = this.meshDraws[ i ];
                if ( d.count <= 0 ) continue;
                pass.setVertexBuffer( 0, d.mesh.buffer );
                pass.draw( d.mesh.count, d.count, 0, d.first );
            }
        }

        if ( this.lineCount > 0 ) {
            pass.setPipeline( this.linePipeline );
            pass.setVertexBuffer( 0, this.lineBuffer );
            pass.draw( this.lineCount );
        }

        pass.setPipeline( this.markerPipeline );
        if ( this.sky.count > 0 ) {
            pass.setBindGroup( 1, this.sky.bindGroup );
            pass.draw( 6, this.sky.count );
        }
        if ( this.markers.count > 0 ) {
            pass.setBindGroup( 1, this.markers.bindGroup );
            pass.draw( 6, this.markers.count );
        }

        if ( this.overlay.count > 0 ) {
            pass.setPipeline( this.overlayPipeline );
            pass.setBindGroup( 1, this.overlay.bindGroup );
            pass.draw( 6, this.overlay.count );
        }

        pass.end();
        this.device.queue.submit( [ encoder.finish() ] );
    }
}
