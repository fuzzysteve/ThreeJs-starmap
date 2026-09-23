// Fly-through solar system viewer - the app half of gpusystem.php.
// Rendering lives in gpusystem-render.js; this file owns the data, the
// float64 camera, level-of-detail decisions, labels, picking and UI.
//
// Everything is kept in real SDE metres (float64 in JS). Each frame the
// camera position is subtracted in float64 before anything is handed to
// the GPU as float32, so a 20km station is as crisp next to you as a
// planet is from across the system.
//
// Level of detail, per object per frame:
//   - frustum culled when off screen
//   - drawn as a ray-traced sphere only once it covers >= SPHERE_MIN_PX;
//     surface noise octaves also scale with on-screen size
//   - below that, a small marker keeps "navigational" objects findable
//     (star, planets, stargates always; a moon/station/belt only once it
//     is visibly separated from its parent, so moons don't all pile onto
//     their planet's marker at system scale)
//   - otherwise not drawn at all
//   - labels follow the same separation rules with a stricter threshold,
//     are hidden behind nearer spheres, and are decluttered by priority
//   - orbit rings fade in by projected size and get more segments the
//     larger they appear
//   - asteroid belts grow a procedural rock field once the field itself
//     spans a few pixels; each rock is then culled on its own size, so
//     from afar only the big ones show and the rubble fills in as you close

import { Renderer, SPHERE_FLOATS, MARKER_FLOATS, LINE_FLOATS, MESH_FLOATS, MESH_STYLE, GATE_RING, SHAPE } from './gpusystem-render.js';

var DATA_URL = 'gpusystem-data.php';
var SEARCH_URL = 'search.php';

var FOV_Y = 60 * Math.PI / 180;
var NEAR = 1;
var AU = 149597870700;

var SPHERE_MIN_PX = 1;          // below this a body's disc isn't drawn
var MARKER_MAX_PX = 4;          // above this a body's disc is its own marker
var CHILD_MARKER_SEP_PX = 8;    // moon/station/belt marker needs this gap from its parent
var CHILD_LABEL_SEP_PX = 26;    // ...and this much before it earns a label
var RING_MIN_PX = 4;
var ROCKFIELD_MIN_PX = 6;       // a belt's rock field is generated/drawn once it spans this
var ROCK_MIN_PX = 0.75;         // an individual rock below this is dropped
var ROCK_VARIANTS = 4;

// the flyable Rifter: SDE radius (types.jsonl, typeID 587). CCP's model is
// a client resource; the mesh is Deamos' CC BY Rifter STL converted by
// tools/stl-to-mesh.py (models/rifter.json + .bin), with the procedural
// buildRifter() as a fallback if that can't be loaded
var SHIP_MODEL_URL = 'models/rifter.json';
var SHIP_RADIUS = 31;
var SHIP_OFFSET = [ 0, -1.1 * SHIP_RADIUS, -4.2 * SHIP_RADIUS ];   // camera-local: below and ahead
var SHIP_HULL_COLOR = [ 0.4, 0.31, 0.25 ];    // gunmetal brown, rust in the plating
var SHIP_GLOW_COLOR = [ 1.0, 0.55, 0.25 ];

// the SDE has no radius for stations or stargates - these are display
// sizes only, and the UI says so wherever it shows them
var NOMINAL_RADIUS = { station: 10000, gate: 5000 };

var PLANET_STYLES = {
    'Gas':            { shade: 1, color: [ 0.85, 0.68, 0.46 ], css: '#d9b27c', atmosphere: 1 },
    'Barren':         { shade: 2, color: [ 0.58, 0.52, 0.46 ], css: '#a08f7d', atmosphere: 0 },
    'Scorched Barren':{ shade: 2, color: [ 0.45, 0.33, 0.25 ], css: '#8c6a50', atmosphere: 0 },
    'Temperate':      { shade: 3, color: [ 0.4, 0.6, 0.4 ],    css: '#6fbf73', atmosphere: 1 },
    'Lava':           { shade: 4, color: [ 0.5, 0.2, 0.1 ],    css: '#e0673a', atmosphere: 0.4 },
    'Storm':          { shade: 5, color: [ 0.45, 0.55, 0.72 ], css: '#8aa6d6', atmosphere: 1 },
    'Ice':            { shade: 6, color: [ 0.8, 0.9, 1.0 ],    css: '#cfe8ff', atmosphere: 0.6 },
    'Oceanic':        { shade: 7, color: [ 0.2, 0.4, 0.8 ],    css: '#4f86e0', atmosphere: 1 },
    'Plasma':         { shade: 8, color: [ 0.9, 0.45, 0.75 ],  css: '#e070c0', atmosphere: 1 },
    'Shattered':      { shade: 9, color: [ 0.5, 0.45, 0.4 ],   css: '#b08a70', atmosphere: 0 }
};

var KIND_PRIORITY = { sun: 100, planet: 80, gate: 70, station: 50, moon: 40, belt: 30, other: 10 };

// ------------------------------------------------------------------ math

function v3sub( a, b ) { return [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ]; }
function v3add( a, b ) { return [ a[ 0 ] + b[ 0 ], a[ 1 ] + b[ 1 ], a[ 2 ] + b[ 2 ] ]; }
function v3scale( a, s ) { return [ a[ 0 ] * s, a[ 1 ] * s, a[ 2 ] * s ]; }
function v3dot( a, b ) { return a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ]; }
function v3len( a ) { return Math.sqrt( v3dot( a, a ) ); }
function v3cross( a, b ) {
    return [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
}
function v3norm( a ) {
    var l = v3len( a );
    return l > 0 ? [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ] : [ 0, 0, 0 ];
}
function anyPerpendicular( a ) {
    var helper = Math.abs( a[ 1 ] ) < 0.9 ? [ 0, 1, 0 ] : [ 1, 0, 0 ];
    return v3norm( v3cross( a, helper ) );
}
// spherical interpolation between two unit vectors
function v3slerp( a, b, t ) {
    var d = Math.max( -1, Math.min( 1, v3dot( a, b ) ) );
    var angle = Math.acos( d );
    if ( angle < 1e-6 ) return a.slice();
    var axis = angle > Math.PI - 1e-3 ? anyPerpendicular( a ) : v3norm( v3cross( a, b ) );
    return qRot( qAxis( axis, angle * t ), a );
}

function qMul( a, b ) {
    return [
        a[ 3 ] * b[ 0 ] + a[ 0 ] * b[ 3 ] + a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ],
        a[ 3 ] * b[ 1 ] - a[ 0 ] * b[ 2 ] + a[ 1 ] * b[ 3 ] + a[ 2 ] * b[ 0 ],
        a[ 3 ] * b[ 2 ] + a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] + a[ 2 ] * b[ 3 ],
        a[ 3 ] * b[ 3 ] - a[ 0 ] * b[ 0 ] - a[ 1 ] * b[ 1 ] - a[ 2 ] * b[ 2 ]
    ];
}
function qAxis( axis, angle ) {
    var s = Math.sin( angle / 2 );
    return [ axis[ 0 ] * s, axis[ 1 ] * s, axis[ 2 ] * s, Math.cos( angle / 2 ) ];
}
function qNorm( q ) {
    var l = Math.hypot( q[ 0 ], q[ 1 ], q[ 2 ], q[ 3 ] );
    return [ q[ 0 ] / l, q[ 1 ] / l, q[ 2 ] / l, q[ 3 ] / l ];
}
function qRot( q, v ) {
    var x = q[ 0 ], y = q[ 1 ], z = q[ 2 ], w = q[ 3 ];
    var tx = 2 * ( y * v[ 2 ] - z * v[ 1 ] );
    var ty = 2 * ( z * v[ 0 ] - x * v[ 2 ] );
    var tz = 2 * ( x * v[ 1 ] - y * v[ 0 ] );
    return [
        v[ 0 ] + w * tx + ( y * tz - z * ty ),
        v[ 1 ] + w * ty + ( z * tx - x * tz ),
        v[ 2 ] + w * tz + ( x * ty - y * tx )
    ];
}
function qSlerp( a, b, t ) {
    var d = a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ] + a[ 3 ] * b[ 3 ];
    if ( d < 0 ) { b = [ -b[ 0 ], -b[ 1 ], -b[ 2 ], -b[ 3 ] ]; d = -d; }
    if ( d > 0.9995 ) {
        return qNorm( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t,
            a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t, a[ 3 ] + ( b[ 3 ] - a[ 3 ] ) * t ] );
    }
    var th = Math.acos( d ), s = Math.sin( th );
    var wa = Math.sin( ( 1 - t ) * th ) / s, wb = Math.sin( t * th ) / s;
    return [ a[ 0 ] * wa + b[ 0 ] * wb, a[ 1 ] * wa + b[ 1 ] * wb, a[ 2 ] * wa + b[ 2 ] * wb, a[ 3 ] * wa + b[ 3 ] * wb ];
}
// quaternion whose rotation matrix has columns right, up, back
function qFromBasis( r, u, b ) {
    var m00 = r[ 0 ], m01 = u[ 0 ], m02 = b[ 0 ];
    var m10 = r[ 1 ], m11 = u[ 1 ], m12 = b[ 1 ];
    var m20 = r[ 2 ], m21 = u[ 2 ], m22 = b[ 2 ];
    var tr = m00 + m11 + m22, s;
    if ( tr > 0 ) {
        s = 0.5 / Math.sqrt( tr + 1 );
        return qNorm( [ ( m21 - m12 ) * s, ( m02 - m20 ) * s, ( m10 - m01 ) * s, 0.25 / s ] );
    } else if ( m00 > m11 && m00 > m22 ) {
        s = 2 * Math.sqrt( 1 + m00 - m11 - m22 );
        return qNorm( [ 0.25 * s, ( m01 + m10 ) / s, ( m02 + m20 ) / s, ( m21 - m12 ) / s ] );
    } else if ( m11 > m22 ) {
        s = 2 * Math.sqrt( 1 + m11 - m00 - m22 );
        return qNorm( [ ( m01 + m10 ) / s, 0.25 * s, ( m12 + m21 ) / s, ( m02 - m20 ) / s ] );
    }
    s = 2 * Math.sqrt( 1 + m22 - m00 - m11 );
    return qNorm( [ ( m02 + m20 ) / s, ( m12 + m21 ) / s, 0.25 * s, ( m10 - m01 ) / s ] );
}
function qLookAt( forward, up ) {
    var f = v3norm( forward );
    var r = v3cross( f, up );
    if ( v3len( r ) < 1e-6 ) r = v3cross( f, anyPerpendicular( f ) );
    r = v3norm( r );
    var u = v3cross( r, f );
    return qFromBasis( r, u, v3scale( f, -1 ) );
}

// small seeded PRNG so a belt or station looks the same on every visit
function mulberry32( seed ) {
    var a = seed >>> 0;
    return function () {
        a = ( a + 0x6D2B79F5 ) | 0;
        var t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
        t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
        return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
    };
}
// uniformly distributed random orientation (Shoemake)
function randomQuat( rng ) {
    var u1 = rng(), u2 = rng() * Math.PI * 2, u3 = rng() * Math.PI * 2;
    var a = Math.sqrt( 1 - u1 ), b = Math.sqrt( u1 );
    return [ a * Math.sin( u2 ), a * Math.cos( u2 ), b * Math.sin( u3 ), b * Math.cos( u3 ) ];
}

function smoothstep( a, b, x ) {
    var t = Math.max( 0, Math.min( 1, ( x - a ) / ( b - a ) ) );
    return t * t * ( 3 - 2 * t );
}
function clamp( x, a, b ) { return Math.max( a, Math.min( b, x ) ); }

// ------------------------------------------------------------ formatting

function fmtDistance( m ) {
    if ( !isFinite( m ) ) return '-';
    if ( m < 10000 ) return Math.round( m ).toLocaleString() + ' m';
    if ( m < 0.1 * AU ) return Math.round( m / 1000 ).toLocaleString() + ' km';
    return ( m / AU ).toFixed( m < 10 * AU ? 2 : 1 ) + ' AU';
}
function fmtSpeed( ms ) {
    if ( ms < 10000 ) return Math.round( ms ).toLocaleString() + ' m/s';
    if ( ms < 0.1 * AU ) return Math.round( ms / 1000 ).toLocaleString() + ' km/s';
    return ( ms / AU ).toFixed( 2 ) + ' AU/s';
}
function fmtDuration( s ) {
    var days = s / 86400;
    if ( days >= 2 ) return days.toFixed( 1 ) + ' days';
    return ( s / 3600 ).toFixed( 1 ) + ' hours';
}

// EVE rounds displayed security up to 0.1 for anything just above zero
function displaySecurity( sec ) {
    if ( sec > 0 && sec < 0.05 ) return 0.1;
    return Math.round( sec * 10 ) / 10;
}
var SEC_COLORS = [ '#f00000', '#d73000', '#f04800', '#f06000', '#d77700', '#efef00',
    '#8fef2f', '#00f000', '#00ef47', '#48f0c0', '#2fefef' ];
function secColor( sec ) {
    var s = displaySecurity( sec );
    return SEC_COLORS[ clamp( Math.round( s * 10 ), 0, 10 ) ];
}
function cssToRgb( css ) {
    var n = parseInt( css.slice( 1 ), 16 );
    return [ ( n >> 16 & 255 ) / 255, ( n >> 8 & 255 ) / 255, ( n & 255 ) / 255 ];
}
function rgbToCss( c ) {
    return 'rgb(' + c.map( function ( x ) { return Math.round( clamp( x, 0, 1 ) * 255 ); } ).join( ',' ) + ')';
}

// approximate black-body colour (Tanner Helland's fit), for the star
function kelvinToRgb( k ) {
    var t = k / 100, r, g, b;
    if ( t <= 66 ) {
        r = 255;
        g = 99.4708025861 * Math.log( t ) - 161.1195681661;
        b = t <= 19 ? 0 : 138.5177312231 * Math.log( t - 10 ) - 305.0447927307;
    } else {
        r = 329.698727446 * Math.pow( t - 60, -0.1332047592 );
        g = 288.1221695283 * Math.pow( t - 60, -0.0755148492 );
        b = 255;
    }
    return [ clamp( r, 0, 255 ) / 255, clamp( g, 0, 255 ) / 255, clamp( b, 0, 255 ) / 255 ];
}

function escapeHtml( s ) {
    return String( s ).replace( /[&<>"']/g, function ( c ) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ];
    } );
}

// -------------------------------------------------------------- geometry

// flat-shaded triangle, wound counter-clockwise seen from outside (the
// shapes here are all star-shaped around the origin)
function pushTri( out, a, b, c ) {
    var n = v3cross( v3sub( b, a ), v3sub( c, a ) );
    if ( v3dot( n, v3add( v3add( a, b ), c ) ) < 0 ) {
        var t = b; b = c; c = t;
        n = v3scale( n, -1 );
    }
    n = v3norm( n );
    [ a, b, c ].forEach( function ( v ) { out.push( v[ 0 ], v[ 1 ], v[ 2 ], n[ 0 ], n[ 1 ], n[ 2 ] ); } );
}

// regular dodecahedron, circumradius 1. Built face by face: the 12 face
// normals are the icosahedron's vertices, and each face is the 5 corners
// furthest along its normal, fanned into 3 triangles
function buildDodecahedron() {
    var phi = ( 1 + Math.sqrt( 5 ) ) / 2, ip = 1 / phi;
    var verts = [];
    [ -1, 1 ].forEach( function ( x ) { [ -1, 1 ].forEach( function ( y ) { [ -1, 1 ].forEach( function ( z ) { verts.push( [ x, y, z ] ); } ); } ); } );
    [ -1, 1 ].forEach( function ( a ) {
        [ -1, 1 ].forEach( function ( b ) {
            verts.push( [ 0, a * ip, b * phi ], [ a * ip, b * phi, 0 ], [ a * phi, 0, b * ip ] );
        } );
    } );
    verts = verts.map( function ( v ) { return v3scale( v, 1 / Math.sqrt( 3 ) ); } );

    var normals = [];
    [ -1, 1 ].forEach( function ( a ) {
        [ -1, 1 ].forEach( function ( b ) {
            normals.push( v3norm( [ 0, a * phi, b ] ), v3norm( [ a, 0, b * phi ] ), v3norm( [ a * phi, b, 0 ] ) );
        } );
    } );

    var out = [];
    normals.forEach( function ( f ) {
        var face = verts.slice().sort( function ( p, q ) { return v3dot( q, f ) - v3dot( p, f ); } ).slice( 0, 5 );
        var e1 = v3norm( v3sub( face[ 0 ], v3scale( f, v3dot( face[ 0 ], f ) ) ) );
        var e2 = v3cross( f, e1 );
        face.sort( function ( p, q ) {
            return Math.atan2( v3dot( p, e2 ), v3dot( p, e1 ) ) - Math.atan2( v3dot( q, e2 ), v3dot( q, e1 ) );
        } );
        for ( var i = 1; i < 4; i++ ) pushTri( out, face[ 0 ], face[ i ], face[ i + 1 ] );
    } );
    return new Float32Array( out );
}

// lumpy asteroid: an icosphere (320 faces) pushed in and out by a handful
// of random broad lobes, flat-shaded so it reads as faceted rock
function buildRock( seed ) {
    var rng = mulberry32( seed * 7919 + 17 );
    var t = ( 1 + Math.sqrt( 5 ) ) / 2;
    var verts = [ [ -1, t, 0 ], [ 1, t, 0 ], [ -1, -t, 0 ], [ 1, -t, 0 ], [ 0, -1, t ], [ 0, 1, t ],
        [ 0, -1, -t ], [ 0, 1, -t ], [ t, 0, -1 ], [ t, 0, 1 ], [ -t, 0, -1 ], [ -t, 0, 1 ] ].map( v3norm );
    var faces = [ [ 0, 11, 5 ], [ 0, 5, 1 ], [ 0, 1, 7 ], [ 0, 7, 10 ], [ 0, 10, 11 ], [ 1, 5, 9 ], [ 5, 11, 4 ],
        [ 11, 10, 2 ], [ 10, 7, 6 ], [ 7, 1, 8 ], [ 3, 9, 4 ], [ 3, 4, 2 ], [ 3, 2, 6 ], [ 3, 6, 8 ], [ 3, 8, 9 ],
        [ 4, 9, 5 ], [ 2, 4, 11 ], [ 6, 2, 10 ], [ 8, 6, 7 ], [ 9, 8, 1 ] ];
    for ( var level = 0; level < 2; level++ ) {
        var cache = {}, next = [];
        var mid = function ( a, b ) {
            var key = a < b ? a + '_' + b : b + '_' + a;
            if ( cache[ key ] === undefined ) {
                verts.push( v3norm( v3scale( v3add( verts[ a ], verts[ b ] ), 0.5 ) ) );
                cache[ key ] = verts.length - 1;
            }
            return cache[ key ];
        };
        faces.forEach( function ( f ) {
            var ab = mid( f[ 0 ], f[ 1 ] ), bc = mid( f[ 1 ], f[ 2 ] ), ca = mid( f[ 2 ], f[ 0 ] );
            next.push( [ f[ 0 ], ab, ca ], [ f[ 1 ], bc, ab ], [ f[ 2 ], ca, bc ], [ ab, bc, ca ] );
        } );
        faces = next;
    }

    var lobes = [];
    for ( var k = 0; k < 9; k++ ) {
        lobes.push( { d: v3norm( [ rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1 ] ), a: ( rng() * 2 - 1 ) * 0.28, p: 2 + rng() * 4 } );
    }
    var maxR = 0;
    var shaped = verts.map( function ( v ) {
        var r = 1 + ( rng() - 0.5 ) * 0.06;
        lobes.forEach( function ( l ) { r += l.a * Math.pow( Math.max( v3dot( v, l.d ), 0 ), l.p ); } );
        r = Math.max( r, 0.45 );
        maxR = Math.max( maxR, r );
        return v3scale( v, r );
    } );
    shaped = shaped.map( function ( v ) { return v3scale( v, 1 / maxR ); } );

    var out = [];
    faces.forEach( function ( f ) { pushTri( out, shaped[ f[ 0 ] ], shaped[ f[ 1 ] ], shaped[ f[ 2 ] ] ); } );
    return new Float32Array( out );
}

// stargate ring: a torus around local +z with circumradius 1. Winding and
// smooth normals are written out directly - the centroid test in pushTri
// doesn't work for a shape with a hole
function buildTorus( major, minor, segU, segV ) {
    var out = [];
    var vert = function ( i, j ) {
        var u = i / segU * Math.PI * 2, v = j / segV * Math.PI * 2;
        var cu = Math.cos( u ), su = Math.sin( u ), cv = Math.cos( v ), sv = Math.sin( v );
        return [ ( major + minor * cv ) * cu, ( major + minor * cv ) * su, minor * sv, cv * cu, cv * su, sv ];
    };
    for ( var i = 0; i < segU; i++ ) {
        for ( var j = 0; j < segV; j++ ) {
            // (du x dv) points outward, so this order is counter-clockwise
            var a = vert( i, j ), b = vert( i + 1, j ), c = vert( i + 1, j + 1 ), d = vert( i, j + 1 );
            [ a, b, c, a, c, d ].forEach( function ( p ) { out.push.apply( out, p ); } );
        }
    }
    return new Float32Array( out );
}

// flat-shaded triangle facing away from `inside` - for convex parts
function pushTriAway( out, a, b, c, inside ) {
    var n = v3cross( v3sub( b, a ), v3sub( c, a ) );
    var centroid = v3scale( v3add( v3add( a, b ), c ), 1 / 3 );
    if ( v3dot( n, v3sub( centroid, inside ) ) < 0 ) {
        var t = b; b = c; c = t;
        n = v3scale( n, -1 );
    }
    n = v3norm( n );
    [ a, b, c ].forEach( function ( v ) { out.push( v[ 0 ], v[ 1 ], v[ 2 ], n[ 0 ], n[ 1 ], n[ 2 ] ); } );
}

function pushQuadAway( out, a, b, c, d, inside ) {
    pushTriAway( out, a, b, c, inside );
    pushTriAway( out, a, c, d, inside );
}

// thin plate through the quad a-b-c-d, `t` thick
function addSlab( out, a, b, c, d, t ) {
    var n = v3scale( v3norm( v3cross( v3sub( b, a ), v3sub( d, a ) ) ), t / 2 );
    var top = [ a, b, c, d ].map( function ( p ) { return v3add( p, n ); } );
    var bot = [ a, b, c, d ].map( function ( p ) { return v3sub( p, n ); } );
    var centre = v3scale( v3add( v3add( a, b ), v3add( c, d ) ), 0.25 );
    pushQuadAway( out, top[ 0 ], top[ 1 ], top[ 2 ], top[ 3 ], centre );
    pushQuadAway( out, bot[ 0 ], bot[ 1 ], bot[ 2 ], bot[ 3 ], centre );
    for ( var i = 0; i < 4; i++ ) {
        var j = ( i + 1 ) % 4;
        pushQuadAway( out, top[ i ], top[ j ], bot[ j ], bot[ i ], centre );
    }
}

// box between two points, `w` wide and `h` tall (for beams, struts, rods)
function addBeam( out, a, b, w, h ) {
    var d = v3norm( v3sub( b, a ) );
    var side = v3norm( v3cross( d, Math.abs( d[ 1 ] ) > 0.9 ? [ 1, 0, 0 ] : [ 0, 1, 0 ] ) );
    var up = v3cross( side, d );
    var corner = function ( p, sx, sy ) { return v3add( p, v3add( v3scale( side, sx * w / 2 ), v3scale( up, sy * h / 2 ) ) ); };
    var A = [ corner( a, -1, -1 ), corner( a, 1, -1 ), corner( a, 1, 1 ), corner( a, -1, 1 ) ];
    var B = [ corner( b, -1, -1 ), corner( b, 1, -1 ), corner( b, 1, 1 ), corner( b, -1, 1 ) ];
    var centre = v3scale( v3add( a, b ), 0.5 );
    for ( var i = 0; i < 4; i++ ) {
        var j = ( i + 1 ) % 4;
        pushQuadAway( out, A[ i ], A[ j ], B[ j ], B[ i ], centre );
    }
    pushQuadAway( out, A[ 0 ], A[ 1 ], A[ 2 ], A[ 3 ], centre );
    pushQuadAway( out, B[ 0 ], B[ 1 ], B[ 2 ], B[ 3 ], centre );
}

// axis-aligned box from its centre and half-extents
function addBox( out, c, hx, hy, hz ) {
    addBeam( out, [ c[ 0 ], c[ 1 ], c[ 2 ] - hz ], [ c[ 0 ], c[ 1 ], c[ 2 ] + hz ], hx * 2, hy * 2 );
}

// rounded-rectangle cross-section, `per` extra points on each corner arc
function roundedRect( hw, hh, r, per ) {
    var pts = [];
    var corners = [ [ hw - r, hh - r, 0 ], [ -hw + r, hh - r, 1 ], [ -hw + r, -hh + r, 2 ], [ hw - r, -hh + r, 3 ] ];
    corners.forEach( function ( c ) {
        for ( var i = 0; i <= per; i++ ) {
            var a = ( c[ 2 ] + i / per ) * Math.PI / 2;
            pts.push( [ c[ 0 ] + Math.cos( a ) * r, c[ 1 ] + Math.sin( a ) * r ] );
        }
    } );
    return pts;
}

// skin a list of same-sized convex rings (each ring's points share one z,
// or are close to it), capping both ends with fans
function addLoft( out, rings, capStart, capEnd ) {
    var centreOf = function ( r ) {
        return r.reduce( function ( acc, p ) { return v3add( acc, v3scale( p, 1 / r.length ) ); }, [ 0, 0, 0 ] );
    };
    var n = rings[ 0 ].length;
    for ( var i = 0; i < rings.length - 1; i++ ) {
        var mid = v3scale( v3add( centreOf( rings[ i ] ), centreOf( rings[ i + 1 ] ) ), 0.5 );
        for ( var k = 0; k < n; k++ ) {
            var k2 = ( k + 1 ) % n;
            pushQuadAway( out, rings[ i ][ k ], rings[ i ][ k2 ], rings[ i + 1 ][ k2 ], rings[ i + 1 ][ k ], mid );
        }
    }
    [ [ 0, capStart, 1 ], [ rings.length - 1, capEnd, -1 ] ].forEach( function ( e ) {
        if ( !e[ 1 ] ) return;
        var r = rings[ e[ 0 ] ], c = centreOf( r );
        var inward = v3norm( v3sub( centreOf( rings[ e[ 0 ] + e[ 2 ] ] ), c ) );
        for ( var k = 0; k < n; k++ ) pushTriAway( out, c, r[ k ], r[ ( k + 1 ) % n ], v3add( c, inward ) );
    } );
}

// box along z with every edge chamfered - reads as machined plating
function addChamferBox( out, c, hx, hy, hz, ch ) {
    var ring = function ( z, shrink ) {
        return roundedRect( hx - shrink, hy - shrink, Math.max( ch - shrink, 0.05 ), 1 ).map( function ( p ) {
            return [ c[ 0 ] + p[ 0 ], c[ 1 ] + p[ 1 ], z ];
        } );
    };
    addLoft( out, [ ring( c[ 2 ] - hz, ch * 0.7 ), ring( c[ 2 ] - hz + ch, 0 ), ring( c[ 2 ] + hz - ch, 0 ), ring( c[ 2 ] + hz, ch * 0.7 ) ], true, true );
}

// tapered spike from base to tip
function addSpire( out, base, tip, r, segs ) {
    var d = v3norm( v3sub( tip, base ) );
    var side = v3norm( v3cross( d, Math.abs( d[ 1 ] ) > 0.9 ? [ 1, 0, 0 ] : [ 0, 1, 0 ] ) );
    var up = v3cross( side, d );
    var centre = v3add( base, v3scale( v3sub( tip, base ), 0.3 ) );
    var ring = [];
    for ( var i = 0; i < segs; i++ ) {
        var a = i / segs * Math.PI * 2;
        ring.push( v3add( base, v3add( v3scale( side, Math.cos( a ) * r ), v3scale( up, Math.sin( a ) * r ) ) ) );
    }
    for ( var k = 0; k < segs; k++ ) {
        var k2 = ( k + 1 ) % segs;
        pushTriAway( out, ring[ k ], ring[ k2 ], tip, centre );
        pushTriAway( out, base, ring[ k2 ], ring[ k ], v3add( base, v3scale( d, 0.1 ) ) );
    }
}

// ladder truss between two points: twin rails and rungs
function addTruss( out, a, b, width, rungs ) {
    var d = v3norm( v3sub( b, a ) );
    var side = v3scale( v3norm( v3cross( d, [ 0, 0, 1 ] ) ), width / 2 );
    addBeam( out, v3add( a, side ), v3add( b, side ), 0.35, 0.35 );
    addBeam( out, v3sub( a, side ), v3sub( b, side ), 0.35, 0.35 );
    for ( var i = 1; i < rungs; i++ ) {
        var p = v3add( a, v3scale( v3sub( b, a ), i / rungs ) );
        addBeam( out, v3sub( p, side ), v3add( p, side ), 0.25, 0.25 );
    }
}

// engine bell facing +z: outer shell, lip, and a recessed glowing disc
// written to `glow` (drawn emissive)
function addEngine( out, glow, c, r, z0, z1, segs ) {
    var ring = function ( rad, z ) {
        var pts = [];
        for ( var i = 0; i < segs; i++ ) {
            var a = i / segs * Math.PI * 2;
            pts.push( [ c[ 0 ] + Math.cos( a ) * rad, c[ 1 ] + Math.sin( a ) * rad, z ] );
        }
        return pts;
    };
    addLoft( out, [ ring( r * 0.8, z0 ), ring( r, z0 + ( z1 - z0 ) * 0.3 ), ring( r * 1.08, z1 ) ], true, false );
    // inner wall of the bell, facing inward, down to the glowing disc
    var lipOuter = ring( r * 1.08, z1 ), lipInner = ring( r * 0.85, z1 ), inner = ring( r * 0.8, z1 - r * 0.5 );
    var axisBack = [ c[ 0 ], c[ 1 ], z1 + 10 ];
    for ( var k = 0; k < segs; k++ ) {
        var k2 = ( k + 1 ) % segs;
        pushQuadAway( out, lipOuter[ k ], lipOuter[ k2 ], lipInner[ k2 ], lipInner[ k ], [ c[ 0 ], c[ 1 ], z1 - 1 ] );
        // inner wall normals point toward the axis
        var mid = v3scale( v3add( lipInner[ k ], inner[ k2 ] ), 0.5 );
        var towardAxis = v3add( mid, v3scale( v3norm( v3sub( mid, [ c[ 0 ], c[ 1 ], mid[ 2 ] ] ) ), 1 ) );
        pushQuadAway( out, lipInner[ k ], lipInner[ k2 ], inner[ k2 ], inner[ k ], towardAxis );
        pushTriAway( glow, [ c[ 0 ], c[ 1 ], z1 - r * 0.5 ], inner[ k ], inner[ k2 ], [ c[ 0 ], c[ 1 ], z1 - r * 0.5 - 1 ] );
    }
    return axisBack;
}

// one of the two main pods: a narrow neck running forward from the stern,
// flaring into a long, rib-segmented prow that tapers to a slanted scoop
function addPod( out, xc ) {
    // z, half-width, half-height, centre height
    var sections = [ [ 9, 2.3, 2.5, 0 ], [ 2, 2.1, 2.7, 0.2 ], [ -8, 2.0, 2.8, 0.4 ], [ -13, 2.3, 3.0, 0.4 ] ];
    // the prow: alternating plate/rib rings give the segmented look
    for ( var z = -15, i = 0; z >= -37; z -= 1.6, i++ ) {
        var t = ( -15 - z ) / 22;
        var hw = 3.1 + 1.0 * Math.sin( Math.min( t * 1.4, 1 ) * Math.PI / 2 ) - 1.0 * Math.max( t - 0.75, 0 ) * 4;
        var hh = 3.8 + 1.4 * Math.sin( Math.min( t * 1.4, 1 ) * Math.PI / 2 ) - 1.2 * Math.max( t - 0.75, 0 ) * 4;
        var rib = i % 2 === 0 ? 1.0 : 1.05;
        sections.push( [ z, hw * rib, hh * rib, -0.3 - t * 1.2 ] );
    }
    var last = sections.length - 1;
    var rings = sections.map( function ( s, idx ) {
        return roundedRect( s[ 1 ], s[ 2 ], Math.min( s[ 1 ], s[ 2 ] ) * 0.35, 2 ).map( function ( p ) {
            var zz = s[ 0 ];
            // slanted scoop face on the very front: bottom lip reaches further
            if ( idx === last ) zz -= ( 1 - ( p[ 1 ] + s[ 2 ] ) / ( 2 * s[ 2 ] ) ) * 6;
            return [ xc + p[ 0 ], s[ 3 ] + p[ 1 ], zz ];
        } );
    } );
    addLoft( out, rings, true, true );
    // small outboard fin at the neck
    var sgn = xc < 0 ? -1 : 1;
    addSlab( out, [ xc + sgn * 2.0, 0.8, -6 ], [ xc + sgn * 2.0, 0.8, -12 ], [ xc + sgn * 5.5, 2.8, -11 ], [ xc + sgn * 5.5, 2.8, -7.5 ], 0.35 );
}

// Rifter rebuilt after its in-game renders (nose toward -Z, +Y up): two
// long pods (narrow neck, segmented prow, slanted scoop front) ahead of a
// wide stern beam carrying five engine modules, forward-raking spires at
// both ends, lattice trusses hanging below, and a central spine tower.
// Returns the hull, the glowing engine discs (a separate mesh drawn
// emissive) and the nozzles, recentred and scaled to circumradius 1
function buildRifter() {
    var hull = [], engines = [], nozzles = [];
    var podX = 5.8;

    addPod( hull, -podX );
    addPod( hull, podX );

    // stern beam
    addChamferBox( hull, [ 1, 0.5, 7 ], 27, 1.6, 2.2, 0.5 );
    // central spine and tower, with a pointed cap
    addChamferBox( hull, [ 0, 1.2, -2 ], 1.6, 2.0, 11, 0.4 );
    addChamferBox( hull, [ 0, 2.2, 6 ], 2.6, 3.6, 3.4, 0.5 );
    addSpire( hull, [ 0, 5.6, 6 ], [ 0, 9.5, 3 ], 1.6, 8 );
    // engine modules along the beam: x, half-width, half-height, engine radius
    var modules = [ [ -21, 2.8, 4.2, 1.7 ], [ -11, 3.2, 3.2, 1.9 ], [ 11, 3.2, 3.2, 1.9 ], [ 22, 2.8, 4.4, 1.7 ] ];
    modules.forEach( function ( m ) {
        addChamferBox( hull, [ m[ 0 ], 0.2, 6.5 ], m[ 1 ], m[ 2 ], 3.6, 0.6 );
        addChamferBox( hull, [ m[ 0 ], m[ 2 ] + 0.6, 5 ], m[ 1 ] * 0.6, 0.9, 2, 0.3 );   // top detail
        addEngine( hull, engines, [ m[ 0 ], -0.4, 0 ], m[ 3 ], 9.5, 12.5, 16 );
        nozzles.push( { pos: [ m[ 0 ], -0.4, 12.5 - m[ 3 ] * 0.5 ], radius: m[ 3 ] } );
    } );
    addEngine( hull, engines, [ 0, 0.6, 0 ], 2.3, 9.4, 13, 16 );
    nozzles.push( { pos: [ 0, 0.6, 13 - 2.3 * 0.5 ], radius: 2.3 } );

    // forward-raking spires at the beam ends
    addSpire( hull, [ -24.5, 3, 5 ], [ -29, 13, -24 ], 0.9, 8 );
    addSpire( hull, [ -22, 3.5, 4 ], [ -24.5, 11, -16 ], 0.6, 8 );
    addSpire( hull, [ 25, 3, 5 ], [ 31, 12, -26 ], 0.9, 8 );
    addSpire( hull, [ 22.5, 4, 4 ], [ 25, 12, -12 ], 0.6, 8 );
    // lattice trusses hanging below the end modules and the centre
    addTruss( hull, [ -22, -4, 7 ], [ -23.5, -15, 9 ], 1.6, 8 );
    addTruss( hull, [ 23, -4, 7 ], [ 25, -14, 9 ], 1.6, 8 );
    addTruss( hull, [ -4, -1.5, 6 ], [ -4.5, -9, 8 ], 1.2, 5 );
    addTruss( hull, [ 4.5, -1.5, 6 ], [ 5, -10, 8 ], 1.2, 5 );
    // struts tying the pods' necks to the beam
    addBeam( hull, [ -podX, 0.5, 3 ], [ -podX, 0.5, 7 ], 3.2, 2.6 );
    addBeam( hull, [ podX, 0.5, 3 ], [ podX, 0.5, 7 ], 3.2, 2.6 );

    // recentre on the bounding box, then scale to circumradius 1
    var lo = [ Infinity, Infinity, Infinity ], hi = [ -Infinity, -Infinity, -Infinity ];
    [ hull, engines ].forEach( function ( arr ) {
        for ( var v = 0; v < arr.length; v += 6 ) {
            for ( var a = 0; a < 3; a++ ) { lo[ a ] = Math.min( lo[ a ], arr[ v + a ] ); hi[ a ] = Math.max( hi[ a ], arr[ v + a ] ); }
        }
    } );
    var centre = v3scale( v3add( lo, hi ), 0.5 );
    var maxR = 0;
    [ hull, engines ].forEach( function ( arr ) {
        for ( var v = 0; v < arr.length; v += 6 ) {
            for ( var a = 0; a < 3; a++ ) arr[ v + a ] -= centre[ a ];
            maxR = Math.max( maxR, Math.hypot( arr[ v ], arr[ v + 1 ], arr[ v + 2 ] ) );
        }
    } );
    var scale = function ( arr ) {
        for ( var v = 0; v < arr.length; v += 6 ) { arr[ v ] /= maxR; arr[ v + 1 ] /= maxR; arr[ v + 2 ] /= maxR; }
        return new Float32Array( arr );
    };
    return {
        hull: scale( hull ),
        engines: scale( engines ),
        nozzles: nozzles.map( function ( nz ) {
            return { pos: v3scale( v3sub( nz.pos, centre ), 1 / maxR ), radius: nz.radius / maxR };
        } ),
        triangles: ( hull.length + engines.length ) / 18
    };
}

// Decode a models/*.bin written by tools/stl-to-mesh.py into flat-shaded
// triangles (interleaved position + normal, circumradius 1)
function decodeMeshAsset( buf ) {
    var dv = new DataView( buf );
    if ( String.fromCharCode( dv.getUint8( 0 ), dv.getUint8( 1 ), dv.getUint8( 2 ), dv.getUint8( 3 ) ) !== 'MSH1' ) {
        throw new Error( 'not an MSH1 mesh' );
    }
    var vc = dv.getUint32( 4, true ), ic = dv.getUint32( 8, true );
    var pos = new Int16Array( buf, 12, vc * 3 );
    var idxStart = 12 + Math.ceil( vc * 6 / 4 ) * 4;
    var idx = vc > 65535 ? new Uint32Array( buf, idxStart, ic ) : new Uint16Array( buf, idxStart, ic );
    var out = new Float32Array( ic * 6 );
    var P = function ( i ) { return [ pos[ i * 3 ] / 32767, pos[ i * 3 + 1 ] / 32767, pos[ i * 3 + 2 ] / 32767 ]; };
    for ( var t = 0; t < ic; t += 3 ) {
        var a = P( idx[ t ] ), b = P( idx[ t + 1 ] ), c = P( idx[ t + 2 ] );
        // STL winding is counter-clockwise from outside, so no flip needed
        var n = v3norm( v3cross( v3sub( b, a ), v3sub( c, a ) ) );
        [ a, b, c ].forEach( function ( v, k ) {
            var o = ( t + k ) * 6;
            out[ o ] = v[ 0 ]; out[ o + 1 ] = v[ 1 ]; out[ o + 2 ] = v[ 2 ];
            out[ o + 3 ] = n[ 0 ]; out[ o + 4 ] = n[ 1 ]; out[ o + 5 ] = n[ 2 ];
        } );
    }
    return out;
}

// glowing discs facing +Z (backwards) at each engine, for models that
// have no nozzle geometry of their own
function buildEngineDiscs( engines ) {
    var out = [];
    engines.forEach( function ( e ) {
        var c = v3add( e.pos, [ 0, 0, 0.004 ] ), segs = 16;
        for ( var k = 0; k < segs; k++ ) {
            var a0 = k / segs * Math.PI * 2, a1 = ( k + 1 ) / segs * Math.PI * 2;
            pushTriAway( out, c,
                v3add( c, [ Math.cos( a0 ) * e.radius, Math.sin( a0 ) * e.radius, 0 ] ),
                v3add( c, [ Math.cos( a1 ) * e.radius, Math.sin( a1 ) * e.radius, 0 ] ),
                v3sub( c, [ 0, 0, 1 ] ) );
        }
    } );
    return new Float32Array( out );
}

function loadShipModel() {
    return fetchJson( SHIP_MODEL_URL ).then( function ( meta ) {
        var binUrl = SHIP_MODEL_URL.replace( /[^/]*$/, '' ) + meta.mesh;
        return fetch( binUrl ).then( function ( r ) {
            if ( !r.ok ) throw new Error( 'HTTP ' + r.status + ' loading ' + binUrl );
            return r.arrayBuffer();
        } ).then( function ( buf ) {
            var hull = decodeMeshAsset( buf );
            meshes.ship = renderer.createMesh( hull, 'rifter hull (model)' );
            meshes.shipEngines = renderer.createMesh( buildEngineDiscs( meta.engines ), 'rifter engines (model)' );
            rifter = { nozzles: meta.engines, triangles: meta.triangles, credit: meta.credit };
        } );
    } ).catch( function ( err ) {
        console.warn( 'Rifter model unavailable, using the procedural one', err );
    } );
}

var ROCK_TONES = [ [ 0.46, 0.41, 0.35 ], [ 0.38, 0.37, 0.36 ], [ 0.52, 0.43, 0.32 ], [ 0.42, 0.44, 0.48 ], [ 0.33, 0.29, 0.26 ] ];

// Procedural rock field for an asteroid belt - the SDE gives a belt a
// single position and nothing about its rocks, so these are invented
// (seeded by the belt's itemID so they're stable). A few clumps inside a
// flattened ellipsoid 25-60km across, rock radii following a power law
// from ~250m up to a handful of multi-km giants
function beltField( b ) {
    if ( b.field ) return b.field;
    var rng = mulberry32( b.id );
    var R = 25000 + rng() * 35000;
    var count = 180 + Math.floor( rng() * 170 );
    var e1 = anyPerpendicular( ecliptic ), e2 = v3cross( ecliptic, e1 );
    var clumps = [];
    var nClumps = 3 + Math.floor( rng() * 5 );
    for ( var c = 0; c < nClumps; c++ ) {
        clumps.push( [ ( rng() * 2 - 1 ) * R * 0.55, ( rng() * 2 - 1 ) * R * 0.15, ( rng() * 2 - 1 ) * R * 0.55 ] );
    }
    var gauss = function () {
        return Math.sqrt( -2 * Math.log( Math.max( rng(), 1e-9 ) ) ) * Math.cos( 2 * Math.PI * rng() );
    };
    var rocks = [];
    for ( var i = 0; i < count; i++ ) {
        var cl = clumps[ Math.floor( rng() * clumps.length ) ];
        var spread = R * ( 0.18 + rng() * 0.2 );
        var lx = cl[ 0 ] + gauss() * spread, ly = cl[ 1 ] + gauss() * spread * 0.35, lz = cl[ 2 ] + gauss() * spread;
        var r = i < 3 ? 3500 + rng() * 5000 : Math.min( 250 * Math.pow( 1 - rng() * 0.995, -0.55 ), 6000 );
        var tone = ROCK_TONES[ Math.floor( rng() * ROCK_TONES.length ) ];
        var shade = 0.8 + rng() * 0.4;
        rocks.push( {
            off: v3add( v3add( v3scale( e1, lx ), v3scale( ecliptic, ly ) ), v3scale( e2, lz ) ),
            r: r,
            stretch: [ 0.75 + rng() * 0.5, 0.55 + rng() * 0.45, 0.75 + rng() * 0.5 ],
            q: randomQuat( rng ),
            variant: Math.floor( rng() * ROCK_VARIANTS ),
            color: [ tone[ 0 ] * shade, tone[ 1 ] * shade, tone[ 2 ] * shade ],
            seed: rng()
        } );
    }
    b.field = { radius: R, rocks: rocks };
    return b.field;
}

// ----------------------------------------------------------------- state

var el = {};
[ 'viewport', 'labels', 'systemName', 'systemSec', 'systemLinks', 'tree', 'treeFilter', 'info',
    'status', 'lodStats', 'fps', 'fade', 'loading', 'search', 'searchResults', 'helpPanel',
    'toggleOrbits', 'toggleLabels', 'toggleSky', 'toggleNebula', 'toggleShip', 'skyLight', 'sidebar' ].forEach( function ( id ) {
    el[ id ] = document.getElementById( id );
} );

var renderer = null;
var sys = null;                 // current system info
var bodies = [];
var bodyById = {};
var sun = null;
var ecliptic = [ 0, 1, 0 ];
var systemExtent = 1e12;
var sky = null;                 // { metresPerLy, stars: flat [x,y,z,sec,...] }
var skyGateLabels = [];

var cam = {
    pos: [ 0, 0, 1e12 ],
    q: [ 0, 0, 0, 1 ],
    vel: [ 0, 0, 0 ],
    speedScale: 1
};
var orbitTarget = null;
var selected = null;
var hovered = null;
var flight = null;
var keys = {};
var pointer = { x: -1, y: -1, down: false, button: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, dragged: false };
var settings = { orbits: true, labels: true, sky: true, skyLight: 1, ship: false, nebula: true };
var loadToken = 0;

var view = { w: 1, h: 1, dpr: 1, pxPerRad: 1, right: [ 1, 0, 0 ], up: [ 0, 1, 0 ], fwd: [ 0, 0, -1 ] };

var sphereData = new Float32Array( SPHERE_FLOATS * 256 );
var markerData = new Float32Array( MARKER_FLOATS * 512 );
var overlayData = new Float32Array( MARKER_FLOATS * 8 );
var lineData = new Float32Array( LINE_FLOATS * 8192 );
var meshData = new Float32Array( MESH_FLOATS * 1024 );
var meshes = null;              // { station, gate, rocks: [], ship, shipEngines } GPU vertex buffers
var rifter = null;              // buildRifter() output (nozzle positions)
// the flyable ship rides rigidly in front of the camera, with a little lag
// and banking so turns read as the ship flying rather than the view panning
var ship = { q: [ 0, 0, 0, 1 ], rel: [ 0, 0, 0 ], bank: 0, pitch: 0, slide: 0, thrust: 0, prevQ: null };

var labelPool = [];
var labelRects = [];
var lastHud = 0;
var frameTimes = [];

// ------------------------------------------------------------ system data

function kindOf( groupId ) {
    switch ( groupId ) {
        case 6: return 'sun';
        case 7: return 'planet';
        case 8: return 'moon';
        case 9: return 'belt';
        case 10: return 'gate';
        case 15: return 'station';
        default: return 'other';
    }
}

// drop the parent's name from the front of a child's, so "Jita IV - Moon 4
// - Caldari Navy Assembly Plant" labels as "Caldari Navy Assembly Plant"
// once the moon's own label is right next to it
function shortNameFor( b ) {
    if ( b.kind === 'gate' && b.dest ) return b.dest.systemName;
    if ( b.kind === 'sun' ) return b.name + ' (star)';
    if ( b.parent && b.name.indexOf( b.parent.name + ' - ' ) === 0 ) {
        return b.name.slice( b.parent.name.length + 3 );
    }
    return b.name;
}

function buildBodies( items ) {
    bodies = [];
    bodyById = {};
    sun = null;

    items.forEach( function ( it ) {
        var kind = kindOf( it.groupId );
        var b = {
            id: it.id, name: it.name, kind: kind, group: it.group, typeName: it.typeName || it.group,
            pos: [ it.x, it.y, it.z ], orbitId: it.orbitId, stats: it.stats, dest: it.dest,
            celestialIndex: it.celestialIndex, orbitIndex: it.orbitIndex,
            radius: it.radius || 0, nominal: false, hasSphere: false,
            parent: null, children: [],
            color: [ 0.8, 0.8, 0.8 ], css: '#cccccc', shade: 10, atmosphere: 0,
            seed: ( ( it.id * 2654435761 ) % 1000 ) / 1000,
            marker: SHAPE.DOT, markerPx: 3,
            // per-frame scratch
            rel: [ 0, 0, 0 ], dist: 0, depth: 0, sx: 0, sy: 0, pxR: 0, onScreen: false,
            drawSphere: false, drawMesh: false, drawBody: false, drawMarker: false, markerAlpha: 0, sepPx: Infinity
        };

        if ( kind === 'sun' ) {
            var temp = it.stats && it.stats.temperature ? it.stats.temperature : 5800;
            b.color = kelvinToRgb( temp );
            b.css = rgbToCss( b.color );
            b.shade = 0;
            b.hasSphere = b.radius > 0;
            b.marker = SHAPE.GLOW;
            if ( !sun ) sun = b;
        } else if ( kind === 'planet' ) {
            var m = /\(([^)]+)\)/.exec( b.typeName || '' );
            var st = PLANET_STYLES[ m ? m[ 1 ] : '' ] || PLANET_STYLES.Barren;
            b.color = st.color; b.css = st.css; b.shade = st.shade; b.atmosphere = st.atmosphere;
            b.hasSphere = b.radius > 0;
            b.marker = SHAPE.RING; b.markerPx = 5;
        } else if ( kind === 'moon' ) {
            var g = 0.45 + b.seed * 0.25;
            b.color = [ g, g * 0.97, g * 0.93 ]; b.css = '#9a9a9a'; b.shade = 10;
            b.hasSphere = b.radius > 0;
            b.marker = SHAPE.DOT; b.markerPx = 2.5;
        } else if ( kind === 'station' ) {
            // drawn as a dodecahedron; hasSphere still drives collision and
            // picking, using the dodecahedron's circumradius
            b.radius = NOMINAL_RADIUS.station; b.nominal = true; b.hasSphere = true; b.mesh = 'station';
            b.color = [ 0.55, 0.6, 0.66 ]; b.css = '#33ffcc'; b.shade = 11;
            b.meshQ = randomQuat( mulberry32( it.id ) );
            b.marker = SHAPE.SQUARE; b.markerPx = 4;
        } else if ( kind === 'gate' ) {
            // drawn as a ring whose axis points at the destination system,
            // so you look through it the way it jumps
            b.radius = NOMINAL_RADIUS.gate; b.nominal = true; b.hasSphere = true; b.mesh = 'gate';
            b.css = b.dest ? secColor( b.dest.security ) : '#ffaa33';
            b.color = cssToRgb( b.css );
            if ( b.dest ) {
                var axis = v3norm( [ b.dest.x - sys.x, b.dest.y - sys.y, b.dest.z - sys.z ] );
                var side = anyPerpendicular( axis );
                b.meshQ = qFromBasis( side, v3cross( axis, side ), axis );
            } else {
                b.meshQ = randomQuat( mulberry32( it.id ) );
            }
            b.marker = SHAPE.DIAMOND; b.markerPx = 5;
        } else if ( kind === 'belt' ) {
            // belt "radius" in the SDE isn't a body size, so it's marker-only
            b.radius = 0; b.css = '#c8a26a';
            b.marker = SHAPE.TRIANGLE; b.markerPx = 4;
        } else {
            b.radius = 0; b.css = '#888888';
            b.marker = SHAPE.DOT; b.markerPx = 2;
        }
        b.markerRgb = cssToRgb( b.css.charAt( 0 ) === '#' ? b.css : '#ffffff' );
        if ( kind === 'sun' ) b.markerRgb = b.color;

        bodies.push( b );
        bodyById[ b.id ] = b;
    } );

    bodies.forEach( function ( b ) {
        if ( b.orbitId && bodyById[ b.orbitId ] && b.kind !== 'planet' ) {
            b.parent = bodyById[ b.orbitId ];
            b.parent.children.push( b );
        }
        if ( b.kind === 'planet' && sun ) {
            b.parent = sun;
            sun.children.push( b );
        }
    } );
    bodies.forEach( function ( b ) { b.shortName = shortNameFor( b ); } );

    // best-fit plane of the planets - used as "up" for the overview camera
    // and to flatten belt rock fields
    var planets = bodies.filter( function ( b ) { return b.kind === 'planet'; } );
    var n = [ 0, 0, 0 ];
    var origin = sun ? sun.pos : [ 0, 0, 0 ];
    for ( var i = 0; i < planets.length; i++ ) {
        for ( var j = i + 1; j < planets.length; j++ ) {
            var c = v3cross( v3norm( v3sub( planets[ i ].pos, origin ) ), v3norm( v3sub( planets[ j ].pos, origin ) ) );
            if ( v3dot( c, n ) < 0 ) c = v3scale( c, -1 );
            n = v3add( n, c );
        }
    }
    ecliptic = v3len( n ) > 1e-6 ? v3norm( n ) : [ 0, 1, 0 ];
    if ( ecliptic[ 1 ] < 0 ) ecliptic = v3scale( ecliptic, -1 );

    systemExtent = 1e9;
    bodies.forEach( function ( b ) {
        if ( b.kind === 'planet' || b.kind === 'gate' || b.kind === 'station' ) {
            systemExtent = Math.max( systemExtent, v3len( v3sub( b.pos, origin ) ) );
        }
    } );
}

// Ambient "skybox" light for the night side of bodies. There's no skybox
// texture, so the real star catalogue stands in for one: every system's
// direction and apparent brightness is projected into 9 spherical-harmonic
// coefficients, which the sphere shader turns into irradiance per normal.
// Normalised so the average over the sphere is 1 - the slider and
// SKY_AMBIENT set the actual level, SKY_FLOOR keeps empty sky from going
// fully black
var SKY_AMBIENT = 0.13;
var SKY_FLOOR = 0.35;
var SKY_TINT = [ 0.62, 0.72, 1.0 ];

var skySH = null;

function buildSkyLight() {
    var ly = sky.metresPerLy;
    var here = [ sys.x / ly, sys.y / ly, sys.z / ly ];
    var s = sky.stars;
    var sh = [ 0, 0, 0, 0, 0, 0, 0, 0, 0 ];
    for ( var i = 0; i < s.length; i += 4 ) {
        var dx = s[ i ] - here[ 0 ], dy = s[ i + 1 ] - here[ 1 ], dz = s[ i + 2 ] - here[ 2 ];
        var dist = Math.sqrt( dx * dx + dy * dy + dz * dz );
        if ( dist < 0.01 ) continue;
        var x = dx / dist, y = dy / dist, z = dz / dist;
        // same apparent brightness the background star is drawn with
        var w = clamp( 2.2 / ( 0.6 + dist ), 0.06, 1 );
        sh[ 0 ] += w * 0.282095;
        sh[ 1 ] += w * 0.488603 * y;
        sh[ 2 ] += w * 0.488603 * z;
        sh[ 3 ] += w * 0.488603 * x;
        sh[ 4 ] += w * 1.092548 * x * y;
        sh[ 5 ] += w * 1.092548 * y * z;
        sh[ 6 ] += w * 0.315392 * ( 3 * z * z - 1 );
        sh[ 7 ] += w * 1.092548 * x * z;
        sh[ 8 ] += w * 0.546274 * ( x * x - y * y );
    }
    // mean irradiance over the sphere is c4 * L00
    var k = sh[ 0 ] > 0 ? 1 / ( 0.886227 * sh[ 0 ] ) : 0;
    skySH = sh.map( function ( c ) { return c * k; } );
    applySkyLight();
}

// Per-region nebula palette: two hues seeded by the region ID, so every
// system in a region shares a look, as regions do in game (the real
// backdrops are client art, not SDE data)
var NEBULA_INTENSITY = 0.35;
var nebulaPalette = null;

function hsvToRgb( h, s, v ) {
    var i = Math.floor( h * 6 ), f = h * 6 - i;
    var p = v * ( 1 - s ), q = v * ( 1 - f * s ), t = v * ( 1 - ( 1 - f ) * s );
    return [ [ v, t, p ], [ q, v, p ], [ p, v, t ], [ p, q, v ], [ t, p, v ], [ v, p, q ] ][ i % 6 ];
}

function applyNebula() {
    if ( !renderer || !sys ) return;
    var rng = mulberry32( sys.regionId * 7 + 3 );
    var h1 = rng();
    var h2 = ( h1 + 0.08 + rng() * 0.3 ) % 1;
    nebulaPalette = {
        a: hsvToRgb( h1, 0.55 + rng() * 0.3, 0.9 ),
        b: hsvToRgb( h2, 0.5 + rng() * 0.35, 0.75 ),
        seed: rng() * 20
    };
    renderer.setNebula( nebulaPalette.a, nebulaPalette.b, settings.nebula ? NEBULA_INTENSITY : 0, nebulaPalette.seed );
    applySkyLight();
}

function applySkyLight() {
    if ( !renderer ) return;
    var level = SKY_AMBIENT * settings.skyLight;
    var base = SKY_TINT;
    if ( settings.nebula && nebulaPalette ) {
        // ambient takes on the nebula's colour, normalised to the same brightness
        var avg = [ 0, 1, 2 ].map( function ( i ) { return ( nebulaPalette.a[ i ] + nebulaPalette.b[ i ] ) / 2; } );
        var scale = Math.max( avg[ 0 ], avg[ 1 ], avg[ 2 ], 1e-3 );
        base = SKY_TINT.map( function ( c, i ) { return c * 0.5 + ( avg[ i ] / scale ) * 0.5; } );
    }
    var tint = base.map( function ( c ) { return c * level; } );
    renderer.setSkyLight( skySH || [ 1 / 0.886227, 0, 0, 0, 0, 0, 0, 0, 0 ], tint, SKY_FLOOR );
}

function buildSky() {
    if ( !sky || !sys || !renderer ) return;
    buildSkyLight();
    if ( !settings.sky ) {
        renderer.setSky( new Float32Array( 0 ), 0 );
        skyGateLabels = [];
        return;
    }
    var ly = sky.metresPerLy;
    var here = [ sys.x / ly, sys.y / ly, sys.z / ly ];
    var s = sky.stars;
    var count = s.length / 4;
    var data = new Float32Array( count * MARKER_FLOATS );
    var n = 0;
    for ( var i = 0; i < count; i++ ) {
        var d = [ s[ i * 4 ] - here[ 0 ], s[ i * 4 + 1 ] - here[ 1 ], s[ i * 4 + 2 ] - here[ 2 ] ];
        var dist = v3len( d );
        if ( dist < 0.01 ) continue;
        var dir = v3scale( d, 1e20 / dist );
        var bright = clamp( 2.2 / ( 0.6 + dist ), 0.06, 1 );
        var tint = cssToRgb( secColor( s[ i * 4 + 3 ] ) );
        var o = n * MARKER_FLOATS;
        data[ o ] = dir[ 0 ]; data[ o + 1 ] = dir[ 1 ]; data[ o + 2 ] = dir[ 2 ];
        data[ o + 3 ] = ( 1.5 + 2.5 * bright ) * view.dpr;
        data[ o + 4 ] = 0.75 + 0.25 * tint[ 0 ];
        data[ o + 5 ] = 0.75 + 0.25 * tint[ 1 ];
        data[ o + 6 ] = 0.8 + 0.2 * tint[ 2 ];
        data[ o + 7 ] = 0;  // additive
        data[ o + 8 ] = SHAPE.STAR;
        data[ o + 9 ] = bright;
        n++;
    }
    renderer.setSky( data, n );

    // gate destinations get a faint label in the sky, in the direction
    // of the system that gate leads to
    skyGateLabels = [];
    bodies.forEach( function ( b ) {
        if ( b.kind !== 'gate' || !b.dest ) return;
        var dir = v3norm( [ b.dest.x - sys.x, b.dest.y - sys.y, b.dest.z - sys.z ] );
        skyGateLabels.push( { gate: b, dir: dir } );
    } );
}

// ------------------------------------------------------------- loading

function fetchJson( url ) {
    return fetch( url, { credentials: 'same-origin' } ).then( function ( r ) {
        if ( !r.ok ) throw new Error( 'HTTP ' + r.status + ' loading ' + url );
        return r.json();
    } );
}

// options.arriveGateId - place the camera at this stargate (jumped in)
// options.focusId      - fly to this object after arriving
// options.push         - add a history entry
function loadSystem( systemId, options ) {
    options = options || {};
    var token = ++loadToken;
    el.fade.classList.add( 'on' );
    el.loading.textContent = 'Loading…';
    el.loading.style.display = 'block';

    var wait = new Promise( function ( resolve ) { setTimeout( resolve, 250 ); } );
    return Promise.all( [ fetchJson( DATA_URL + '?system=' + encodeURIComponent( systemId ) ), wait ] )
        .then( function ( results ) {
            if ( token !== loadToken ) return;
            var data = results[ 0 ];
            sys = data.system;
            buildBodies( data.items );
            buildSky();
            applyNebula();
            selected = null;
            hovered = null;
            flight = null;
            orbitTarget = null;
            cam.vel = [ 0, 0, 0 ];

            var arrival = options.arriveGateId ? bodyById[ options.arriveGateId ] : null;
            if ( arrival ) {
                placeAtGate( arrival );
            } else {
                placeOverview();
            }

            buildSystemHeader();
            buildTree();
            renderInfo();

            var url = 'gpusystem.php?system=' + sys.id + ( options.focusId ? '&focus=' + options.focusId : '' );
            if ( options.push ) history.pushState( { system: sys.id }, '', url );
            else history.replaceState( { system: sys.id }, '', url );
            document.title = sys.name + ' - Solar system';

            el.loading.style.display = 'none';
            el.fade.classList.remove( 'on' );

            if ( options.focusId && bodyById[ options.focusId ] ) {
                select( bodyById[ options.focusId ] );
                flyTo( bodyById[ options.focusId ] );
            }
        } )
        .catch( function ( err ) {
            if ( token !== loadToken ) return;
            console.error( err );
            el.loading.textContent = 'Could not load that system: ' + err.message;
            el.fade.classList.remove( 'on' );
        } );
}

function placeOverview() {
    var centre = sun ? sun.pos : [ 0, 0, 0 ];
    var inPlane = anyPerpendicular( ecliptic );
    var tilt = 35 * Math.PI / 180;
    var dir = v3add( v3scale( inPlane, Math.cos( tilt ) ), v3scale( ecliptic, Math.sin( tilt ) ) );
    var dist = systemExtent * 2.1;
    cam.pos = v3add( centre, v3scale( dir, dist ) );
    cam.q = qLookAt( v3scale( dir, -1 ), ecliptic );
    if ( sun ) orbitTarget = sun;
}

// arriving through a gate: sit just off it at a three-quarter angle, so
// the gate is part-lit and the star is off to one side
function placeAtGate( gate ) {
    var centre = sun ? sun.pos : [ 0, 0, 0 ];
    var out = v3norm( v3sub( gate.pos, centre ) );
    if ( v3len( out ) === 0 ) out = [ 0, 0, 1 ];
    var side = v3norm( v3cross( ecliptic, out ) );
    if ( v3len( side ) === 0 ) side = anyPerpendicular( out );
    var offset = v3norm( v3add( v3scale( out, 0.5 ), v3add( side, v3scale( ecliptic, 0.3 ) ) ) );
    cam.pos = v3add( gate.pos, v3scale( offset, gate.radius * 8 ) );
    cam.q = qLookAt( v3sub( gate.pos, cam.pos ), ecliptic );
    select( gate );
    orbitTarget = gate;
}

// --------------------------------------------------------------- camera

function viewDistanceFor( b ) {
    if ( b.kind === 'sun' ) return b.radius * 5;
    if ( b.kind === 'belt' ) return beltField( b ).radius * 2.4;
    if ( b.kind === 'other' ) return 5e7;
    if ( b.nominal ) return b.radius * 6;
    return b.radius * 3.2;
}

// the "jump to": a smooth flight that closes distance on a log scale, so a
// trip across the system and a hop to the next moon both take a few
// seconds and both slow down gracefully on arrival
function flyTo( b ) {
    if ( !b ) return;
    var target = b.pos;
    var fromTarget = v3sub( cam.pos, target );
    var d0 = Math.max( v3len( fromTarget ), 1 );
    var dirStart = v3len( fromTarget ) > 0 ? v3norm( fromTarget ) : [ 0, 0, 1 ];
    var dirEnd = dirStart;
    if ( sun && b !== sun ) {
        // finish on the lit side, a little off the star line so the
        // terminator shows
        var toSun = v3norm( v3sub( sun.pos, target ) );
        dirEnd = v3norm( v3add( v3add( dirStart, v3scale( toSun, 1.6 ) ), v3scale( ecliptic, 0.3 ) ) );
    }
    var d1 = viewDistanceFor( b );
    var ratio = Math.max( d0 / d1, d1 / d0 );
    flight = {
        body: b,
        t: 0,
        duration: clamp( 1.2 + 0.45 * Math.log10( ratio ), 1.2, 6 ),
        d0: d0, d1: d1,
        dirStart: dirStart, dirEnd: dirEnd,
        q0: cam.q.slice()
    };
    orbitTarget = null;
    cam.vel = [ 0, 0, 0 ];
}

function updateFlight( dt ) {
    var f = flight;
    f.t += dt;
    var s = clamp( f.t / f.duration, 0, 1 );
    var e = s * s * s * ( s * ( s * 6 - 15 ) + 10 );
    var logD = Math.log( f.d0 ) + ( Math.log( f.d1 ) - Math.log( f.d0 ) ) * e;
    var dir = v3slerp( f.dirStart, f.dirEnd, e );
    cam.pos = v3add( f.body.pos, v3scale( dir, Math.exp( logD ) ) );
    var up = qRot( cam.q, [ 0, 1, 0 ] );
    var look = qLookAt( v3sub( f.body.pos, cam.pos ), up );
    cam.q = qSlerp( f.q0, look, smoothstep( 0, 0.3, s ) );
    if ( s >= 1 ) {
        cam.q = look;
        orbitTarget = f.body;
        flight = null;
    }
}

function nearestSurfaceDistance() {
    var best = Infinity;
    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        var d = v3len( v3sub( b.pos, cam.pos ) ) - ( b.hasSphere ? b.radius : 0 );
        if ( d < best ) best = d;
    }
    return Math.max( best, 1 );
}

function updateMovement( dt ) {
    var move = [ 0, 0, 0 ];
    if ( keys.KeyW ) move[ 2 ] -= 1;
    if ( keys.KeyS ) move[ 2 ] += 1;
    if ( keys.KeyA ) move[ 0 ] -= 1;
    if ( keys.KeyD ) move[ 0 ] += 1;
    if ( keys.Space ) move[ 1 ] += 1;
    if ( keys.KeyC ) move[ 1 ] -= 1;

    var roll = ( keys.KeyQ ? 1 : 0 ) - ( keys.KeyE ? 1 : 0 );
    if ( roll ) cam.q = qNorm( qMul( cam.q, qAxis( [ 0, 0, 1 ], roll * dt * 1.2 ) ) );

    var yaw = ( keys.ArrowLeft ? 1 : 0 ) - ( keys.ArrowRight ? 1 : 0 );
    var pitch = ( keys.ArrowUp ? 1 : 0 ) - ( keys.ArrowDown ? 1 : 0 );
    if ( yaw || pitch ) {
        cam.q = qNorm( qMul( cam.q, qAxis( [ 0, 1, 0 ], yaw * dt * 1.0 ) ) );
        cam.q = qNorm( qMul( cam.q, qAxis( [ 1, 0, 0 ], pitch * dt * 1.0 ) ) );
    }

    var moving = move[ 0 ] || move[ 1 ] || move[ 2 ];
    if ( moving ) {
        flight = null;
        orbitTarget = null;
    }

    // speed scales with distance to the nearest surface: fast in open
    // space, careful near a station
    var speed = nearestSurfaceDistance() * 0.8 * cam.speedScale;
    if ( keys.ShiftLeft || keys.ShiftRight ) speed *= 6;
    speed = Math.max( speed, 20 );

    var targetVel = [ 0, 0, 0 ];
    if ( moving ) {
        var local = v3norm( move );
        targetVel = v3scale( qRot( cam.q, local ), speed );
    }
    var k = 1 - Math.exp( -dt * 6 );
    cam.vel = v3add( cam.vel, v3scale( v3sub( targetVel, cam.vel ), k ) );
    if ( !moving && v3len( cam.vel ) < 1e-3 ) cam.vel = [ 0, 0, 0 ];
    cam.pos = v3add( cam.pos, v3scale( cam.vel, dt ) );
    cam.currentSpeed = v3len( cam.vel );
}

// keep the point cam.pos + offset at least minD from centre, by moving the camera
function pushOutOf( centre, minD, offset ) {
    var point = offset ? v3add( cam.pos, offset ) : cam.pos;
    var off = v3sub( point, centre );
    var d = v3len( off );
    if ( d >= minD ) return;
    var dir = d > 0 ? v3scale( off, 1 / d ) : [ 0, 0, 1 ];
    cam.pos = v3add( cam.pos, v3sub( v3add( centre, v3scale( dir, minD ) ), point ) );
    var into = v3dot( cam.vel, dir );
    if ( into < 0 ) cam.vel = v3sub( cam.vel, v3scale( dir, into ) );
}

// the camera, and the ship riding ahead of it when shown
function collide( centre, minD ) {
    pushOutOf( centre, minD );
    if ( settings.ship ) pushOutOf( centre, minD + SHIP_RADIUS, ship.rel );
}

function resolveCollisions() {
    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        if ( b.mesh === 'gate' ) {
            // keep clear of the ring's tube, but let the camera fly through the hole
            var axis = qRot( b.meshQ, [ 0, 0, 1 ] );
            var rel = v3sub( cam.pos, b.pos );
            var planar = v3sub( rel, v3scale( axis, v3dot( rel, axis ) ) );
            if ( v3len( planar ) > 1e-6 ) {
                collide( v3add( b.pos, v3scale( v3norm( planar ), GATE_RING.major * b.radius ) ), GATE_RING.minor * b.radius + 20 );
            }
        } else if ( b.hasSphere ) {
            collide( b.pos, b.radius * 1.0005 + 20 );
        }
        // rocks only matter once we're inside a generated field
        if ( b.field && v3len( v3sub( cam.pos, b.pos ) ) < b.field.radius * 2 ) {
            for ( var k = 0; k < b.field.rocks.length; k++ ) {
                var rock = b.field.rocks[ k ];
                collide( v3add( b.pos, rock.off ), rock.r * 0.85 + 20 );
            }
        }
    }
}

function orbitDrag( dx, dy ) {
    var up = qRot( cam.q, [ 0, 1, 0 ] ), right = qRot( cam.q, [ 1, 0, 0 ] );
    var k = 0.005;
    var dq = qNorm( qMul( qAxis( up, -dx * k ), qAxis( right, -dy * k ) ) );
    cam.pos = v3add( orbitTarget.pos, qRot( dq, v3sub( cam.pos, orbitTarget.pos ) ) );
    cam.q = qNorm( qMul( dq, cam.q ) );
}

function lookDrag( dx, dy ) {
    var k = 0.0035;
    cam.q = qNorm( qMul( cam.q, qAxis( [ 0, 1, 0 ], dx * k ) ) );
    cam.q = qNorm( qMul( cam.q, qAxis( [ 1, 0, 0 ], dy * k ) ) );
}

function orbitZoom( deltaY ) {
    var t = orbitTarget;
    var r = t.hasSphere ? t.radius : 0;
    var off = v3sub( cam.pos, t.pos );
    var d = v3len( off );
    var dir = d > 0 ? v3scale( off, 1 / d ) : [ 0, 0, 1 ];
    var surface = Math.max( d - r, 1 );
    surface *= Math.exp( deltaY * 0.0015 );
    surface = clamp( surface, Math.max( r * 0.002, 30 ), 2e14 );
    cam.pos = v3add( t.pos, v3scale( dir, r + surface ) );
}

// ------------------------------------------------------------ per frame

function computeView() {
    view.right = qRot( cam.q, [ 1, 0, 0 ] );
    view.up = qRot( cam.q, [ 0, 1, 0 ] );
    view.back = qRot( cam.q, [ 0, 0, 1 ] );
    view.fwd = v3scale( view.back, -1 );
    view.tanHalf = Math.tan( FOV_Y / 2 );
    view.pxPerRad = view.h / ( 2 * view.tanHalf );
    view.aspect = view.w / view.h;
}

function project( rel ) {
    var z = v3dot( rel, view.fwd );
    return {
        z: z,
        x: view.w / 2 + v3dot( rel, view.right ) / z * view.pxPerRad,
        y: view.h / 2 - v3dot( rel, view.up ) / z * view.pxPerRad
    };
}

var lodCounts = { spheres: 0, markers: 0, labels: 0, hidden: 0, rings: 0, rocks: 0 };

function updateLod() {
    lodCounts.spheres = lodCounts.markers = lodCounts.hidden = 0;
    var margin = 40;

    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        b.rel = v3sub( b.pos, cam.pos );
        b.dist = v3len( b.rel );
        var p = project( b.rel );
        b.depth = p.z;
        b.sx = p.x;
        b.sy = p.y;
        b.pxR = b.radius / Math.max( b.dist, 1 ) * view.pxPerRad;
        var extent = Math.max( b.pxR, 10 ) + margin;
        b.onScreen = p.z > -b.radius && ( p.z <= 0 || ( p.x > -extent && p.x < view.w + extent && p.y > -extent && p.y < view.h + extent ) );
        // a sphere we're right next to can have its centre behind us and
        // still fill the view
        if ( p.z <= 0 ) b.onScreen = b.hasSphere && b.dist < b.radius * 3;
        b.sepPx = b.parent ? v3len( v3sub( b.pos, b.parent.pos ) ) / Math.max( b.dist, 1 ) * view.pxPerRad : Infinity;

        var bodyVisible = b.onScreen && b.hasSphere && b.pxR >= SPHERE_MIN_PX;
        b.drawSphere = bodyVisible && !b.mesh;
        b.drawMesh = bodyVisible && !!b.mesh;
        b.drawBody = bodyVisible;
        b.drawMarker = false;
        b.markerAlpha = 0;

        if ( b.onScreen && p.z > 0 && b.pxR < MARKER_MAX_PX ) {
            if ( b.kind === 'sun' || b.kind === 'planet' || b.kind === 'gate' ) {
                b.markerAlpha = 1;
            } else if ( b.kind === 'other' ) {
                b.markerAlpha = 0.35;
            } else {
                b.markerAlpha = smoothstep( CHILD_MARKER_SEP_PX, CHILD_MARKER_SEP_PX * 2, b.sepPx );
            }
            b.drawMarker = b.markerAlpha > 0.01;
        }
        // the star's glow is drawn at every distance
        if ( b.kind === 'sun' && b.onScreen && p.z > 0 ) {
            b.drawMarker = true;
            b.markerAlpha = 1;
        }

        if ( b.drawBody ) lodCounts.spheres++;
        if ( b.drawMarker && b.kind !== 'sun' ) lodCounts.markers++;
        if ( !b.drawBody && !b.drawMarker ) lodCounts.hidden++;
    }
}

function writeSpheres() {
    var n = 0;
    var needed = bodies.length * SPHERE_FLOATS;
    if ( sphereData.length < needed ) sphereData = new Float32Array( needed );
    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        if ( !b.drawSphere ) continue;
        var o = n * SPHERE_FLOATS;
        var sunDir = sun && b !== sun ? v3norm( v3sub( sun.pos, b.pos ) ) : [ 0, 1, 0 ];
        sphereData[ o ] = b.rel[ 0 ]; sphereData[ o + 1 ] = b.rel[ 1 ]; sphereData[ o + 2 ] = b.rel[ 2 ];
        sphereData[ o + 3 ] = b.radius;
        sphereData[ o + 4 ] = b.color[ 0 ]; sphereData[ o + 5 ] = b.color[ 1 ]; sphereData[ o + 6 ] = b.color[ 2 ];
        sphereData[ o + 7 ] = b.shade;
        sphereData[ o + 8 ] = sunDir[ 0 ]; sphereData[ o + 9 ] = sunDir[ 1 ]; sphereData[ o + 10 ] = sunDir[ 2 ];
        sphereData[ o + 11 ] = b.seed;
        // shading LOD: one noise octave for a speck, eight when it fills the screen
        sphereData[ o + 12 ] = clamp( Math.round( Math.log2( Math.max( b.pxR * view.dpr, 1 ) ) ), 1, 8 );
        sphereData[ o + 13 ] = b.dist < b.radius * 3 ? 1 : 0;
        sphereData[ o + 14 ] = b === selected ? 1 : 0;
        sphereData[ o + 15 ] = b.atmosphere;
        n++;
    }
    renderer.setSpheres( sphereData, n );
}

function putMesh( n, rel, scale, q, stretch, seed, color, style ) {
    var needed = ( n + 1 ) * MESH_FLOATS;
    if ( meshData.length < needed ) {
        var grown = new Float32Array( Math.max( needed, meshData.length * 2 ) );
        grown.set( meshData );
        meshData = grown;
    }
    var o = n * MESH_FLOATS;
    meshData[ o ] = rel[ 0 ]; meshData[ o + 1 ] = rel[ 1 ]; meshData[ o + 2 ] = rel[ 2 ];
    meshData[ o + 3 ] = scale;
    meshData[ o + 4 ] = q[ 0 ]; meshData[ o + 5 ] = q[ 1 ]; meshData[ o + 6 ] = q[ 2 ]; meshData[ o + 7 ] = q[ 3 ];
    meshData[ o + 8 ] = stretch[ 0 ]; meshData[ o + 9 ] = stretch[ 1 ]; meshData[ o + 10 ] = stretch[ 2 ];
    meshData[ o + 11 ] = seed;
    meshData[ o + 12 ] = color[ 0 ]; meshData[ o + 13 ] = color[ 1 ]; meshData[ o + 14 ] = color[ 2 ];
    meshData[ o + 15 ] = style;
}

var UNIT_STRETCH = [ 1, 1, 1 ];

function writeMeshes() {
    var n = 0, draws = [];
    lodCounts.rocks = 0;

    var first;
    [ [ 'station', MESH_STYLE.STATION ], [ 'gate', MESH_STYLE.GATE ] ].forEach( function ( kind ) {
        first = n;
        for ( var i = 0; i < bodies.length; i++ ) {
            var b = bodies[ i ];
            if ( !b.drawMesh || b.mesh !== kind[ 0 ] ) continue;
            putMesh( n++, b.rel, b.radius, b.meshQ, UNIT_STRETCH, b.seed, b.color, kind[ 1 ] );
        }
        draws.push( { mesh: meshes[ kind[ 0 ] ], first: first, count: n - first } );
    } );

    // rocks, bucketed by variant so each variant is one contiguous draw
    var buckets = [];
    for ( var v = 0; v < ROCK_VARIANTS; v++ ) buckets.push( [] );
    for ( var j = 0; j < bodies.length; j++ ) {
        var belt = bodies[ j ];
        if ( belt.kind !== 'belt' ) continue;
        var d = v3len( v3sub( belt.pos, cam.pos ) );
        // largest possible field radius, so we don't generate fields we can't see
        if ( !belt.field && 60000 / Math.max( d, 1 ) * view.pxPerRad < ROCKFIELD_MIN_PX ) continue;
        var field = beltField( belt );
        if ( field.radius / Math.max( d, 1 ) * view.pxPerRad < ROCKFIELD_MIN_PX ) continue;
        if ( v3dot( v3sub( belt.pos, cam.pos ), view.fwd ) < -field.radius ) continue;

        for ( var k = 0; k < field.rocks.length; k++ ) {
            var rock = field.rocks[ k ];
            var rel = v3sub( v3add( belt.pos, rock.off ), cam.pos );
            var dist = v3len( rel );
            var extent = rock.r * Math.max( rock.stretch[ 0 ], rock.stretch[ 1 ], rock.stretch[ 2 ] );
            var px = extent / Math.max( dist, 1 ) * view.pxPerRad;
            if ( px < ROCK_MIN_PX ) continue;
            var z = v3dot( rel, view.fwd );
            if ( z < -extent ) continue;
            if ( z > extent ) {
                var p = project( rel );
                if ( p.x < -px || p.x > view.w + px || p.y < -px || p.y > view.h + px ) continue;
            }
            buckets[ rock.variant ].push( { rock: rock, rel: rel } );
        }
    }
    for ( var bv = 0; bv < ROCK_VARIANTS; bv++ ) {
        first = n;
        buckets[ bv ].forEach( function ( e ) {
            putMesh( n++, e.rel, e.rock.r, e.rock.q, e.rock.stretch, e.rock.seed, e.rock.color, MESH_STYLE.ROCK );
        } );
        lodCounts.rocks += n - first;
        draws.push( { mesh: meshes.rocks[ bv ], first: first, count: n - first } );
    }

    if ( settings.ship ) {
        first = n;
        putMesh( n++, ship.rel, SHIP_RADIUS, ship.q, UNIT_STRETCH, 0, SHIP_HULL_COLOR, MESH_STYLE.SHIP );
        draws.push( { mesh: meshes.ship, first: first, count: 1 } );
        first = n;
        putMesh( n++, ship.rel, SHIP_RADIUS, ship.q, UNIT_STRETCH, ship.thrust, SHIP_GLOW_COLOR, MESH_STYLE.ENGINE );
        draws.push( { mesh: meshes.shipEngines, first: first, count: 1 } );
    }

    renderer.setMeshes( meshData, n, draws );
}

function updateShip( dt ) {
    if ( !settings.ship ) {
        ship.prevQ = null;
        return;
    }
    // camera turn rate in its own frame, from the change in orientation
    var yawRate = 0, pitchRate = 0;
    if ( ship.prevQ && dt > 0 ) {
        var p = ship.prevQ;
        var dq = qMul( [ -p[ 0 ], -p[ 1 ], -p[ 2 ], p[ 3 ] ], cam.q );
        if ( dq[ 3 ] < 0 ) dq = dq.map( function ( c ) { return -c; } );
        pitchRate = 2 * dq[ 0 ] / dt;
        yawRate = 2 * dq[ 1 ] / dt;
    }
    ship.prevQ = cam.q.slice();

    var k = 1 - Math.exp( -dt * 4 );
    ship.bank += ( clamp( yawRate * 0.8, -0.7, 0.7 ) - ship.bank ) * k;
    ship.pitch += ( clamp( -pitchRate * 0.25, -0.3, 0.3 ) - ship.pitch ) * k;
    ship.slide += ( clamp( -yawRate * 0.6, -1, 1 ) * SHIP_RADIUS - ship.slide ) * k;

    var throttle = Math.max( nearestSurfaceDistance() * 0.8 * cam.speedScale, 20 );
    var target = flight ? 1 : clamp( ( cam.currentSpeed || 0 ) / throttle, 0, 1 );
    ship.thrust += ( Math.max( target, 0.08 ) - ship.thrust ) * ( 1 - Math.exp( -dt * 3 ) );

    ship.q = qNorm( qMul( cam.q, qMul( qAxis( [ 0, 0, 1 ], ship.bank ), qAxis( [ 1, 0, 0 ], ship.pitch ) ) ) );
    ship.rel = qRot( cam.q, [ SHIP_OFFSET[ 0 ] + ship.slide, SHIP_OFFSET[ 1 ], SHIP_OFFSET[ 2 ] ] );
}

function putMarker( arr, n, rel, sizeCss, rgb, occlude, shape, alpha ) {
    var o = n * MARKER_FLOATS;
    arr[ o ] = rel[ 0 ]; arr[ o + 1 ] = rel[ 1 ]; arr[ o + 2 ] = rel[ 2 ];
    arr[ o + 3 ] = sizeCss * view.dpr;
    arr[ o + 4 ] = rgb[ 0 ]; arr[ o + 5 ] = rgb[ 1 ]; arr[ o + 6 ] = rgb[ 2 ]; arr[ o + 7 ] = occlude;
    arr[ o + 8 ] = shape;
    arr[ o + 9 ] = alpha;
    arr[ o + 10 ] = 0; arr[ o + 11 ] = 0;
}

function writeMarkers() {
    var needed = ( bodies.length + 32 ) * MARKER_FLOATS;
    if ( markerData.length < needed ) markerData = new Float32Array( needed );
    var n = 0;
    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        if ( !b.drawMarker ) continue;
        if ( b.kind === 'sun' ) {
            var glow = clamp( Math.max( b.pxR * 7, 26 ), 26, 4000 );
            putMarker( markerData, n++, b.rel, glow, b.color, 0, SHAPE.GLOW, 1 );
            continue;
        }
        var hover = b === hovered ? 1.35 : 1;
        putMarker( markerData, n++, b.rel, b.markerPx * hover, b.markerRgb, 1, b.marker, b.markerAlpha );
    }
    if ( settings.ship ) {
        // a short fading plume behind each engine: additive blobs that grow
        // longer and brighter with thrust
        rifter.nozzles.forEach( function ( nz ) {
            var r = nz.radius * SHIP_RADIUS;
            for ( var j = 0; j < 4; j++ ) {
                var back = r * ( 0.4 + j * ( 1.2 + 2.8 * ship.thrust ) );
                var local = v3add( v3scale( nz.pos, SHIP_RADIUS ), [ 0, 0, back ] );
                var rel = v3add( ship.rel, qRot( ship.q, local ) );
                var dist = Math.max( v3len( rel ), 1 );
                var px = r * ( 2.6 - j * 0.45 ) / dist * view.pxPerRad * ( 1 + 1.5 * ship.thrust );
                putMarker( markerData, n++, rel, px, SHIP_GLOW_COLOR, 0, SHAPE.GLOW, ( 0.3 + 0.7 * ship.thrust ) * ( 1 - j * 0.22 ) );
            }
        } );
    }
    renderer.setMarkers( markerData, n );

    var m = 0;
    [ [ selected, SHAPE.BRACKET, [ 0.55, 0.85, 1 ] ], [ hovered !== selected ? hovered : null, SHAPE.RING, [ 1, 1, 1 ] ] ].forEach( function ( entry ) {
        var b = entry[ 0 ];
        if ( !b || b.depth <= 0 ) return;
        var size = Math.max( b.pxR * 1.15, entry[ 1 ] === SHAPE.BRACKET ? 11 : 8 ) + 4;
        if ( size > Math.max( view.w, view.h ) ) return;
        putMarker( overlayData, m++, b.rel, size, entry[ 2 ], 1, entry[ 1 ], entry[ 1 ] === SHAPE.BRACKET ? 0.9 : 0.5 );
    } );
    renderer.setOverlay( overlayData, m );
}

// The SDE has no orbital planes, so this reproduces the in-game map's own
// construction: a circle of radius |child - parent| in the XZ plane,
// passing through (-R, 0, 0), rotated by the shortest-arc rotation that
// takes (-1, 0, 0) onto the parent->child direction. The resulting tilt is
// an artefact of that convention (bodies on the parent's +X side get the
// biggest tilts), not physical data - but it matches what players see.
function clientOrbitBasis( u ) {
    // shortest arc from (-1,0,0) to u: axis (-1,0,0) x u = (0, uz, -uy)
    var axis = [ 0, u[ 2 ], -u[ 1 ] ];
    var angle = Math.acos( clamp( -u[ 0 ], -1, 1 ) );
    var axisLen = v3len( axis );
    var q;
    if ( axisLen > 1e-12 ) q = qAxis( v3scale( axis, 1 / axisLen ), angle );
    else if ( u[ 0 ] < 0 ) q = [ 0, 0, 0, 1 ];         // already (-1,0,0)
    else q = qAxis( [ 0, 1, 0 ], Math.PI );             // exactly opposite: any perpendicular axis
    // u = q * (-1,0,0) by construction; v completes the circle's plane
    return qRot( q, [ 0, 0, 1 ] );
}

// circle through `child` centred on `parent` (see clientOrbitBasis for the
// plane). Vertex 0 sits exactly on the child so the line always threads it
function addRing( verts, count, parent, child, rgb, alpha ) {
    var off = v3sub( child.pos, parent.pos );
    var R = v3len( off );
    if ( R <= 0 ) return count;
    var u = v3scale( off, 1 / R );
    var v = clientOrbitBasis( u );

    var parentDist = v3len( v3sub( parent.pos, cam.pos ) );
    var ringPx = R / Math.max( parentDist, 1 ) * view.pxPerRad;
    var segs = clamp( Math.ceil( ringPx / 3 ), 48, 1024 );

    var needed = ( count + segs * 2 ) * LINE_FLOATS;
    if ( verts.length < needed ) {
        var grown = new Float32Array( Math.max( needed, verts.length * 2 ) );
        grown.set( verts );
        lineData = verts = grown;
    }

    var cx = parent.pos[ 0 ] - cam.pos[ 0 ], cy = parent.pos[ 1 ] - cam.pos[ 1 ], cz = parent.pos[ 2 ] - cam.pos[ 2 ];
    var prev = null;
    for ( var k = 0; k <= segs; k++ ) {
        var a = k / segs * Math.PI * 2;
        var ca = Math.cos( a ) * R, sa = Math.sin( a ) * R;
        var p = [ cx + u[ 0 ] * ca + v[ 0 ] * sa, cy + u[ 1 ] * ca + v[ 1 ] * sa, cz + u[ 2 ] * ca + v[ 2 ] * sa ];
        if ( prev ) {
            for ( var e = 0; e < 2; e++ ) {
                var q = e === 0 ? prev : p;
                var o = count * LINE_FLOATS;
                verts[ o ] = q[ 0 ]; verts[ o + 1 ] = q[ 1 ]; verts[ o + 2 ] = q[ 2 ];
                verts[ o + 3 ] = alpha;
                verts[ o + 4 ] = rgb[ 0 ]; verts[ o + 5 ] = rgb[ 1 ]; verts[ o + 6 ] = rgb[ 2 ]; verts[ o + 7 ] = 1;
                count++;
            }
        }
        prev = p;
    }
    return count;
}

function writeRings() {
    var count = 0;
    lodCounts.rings = 0;
    if ( settings.orbits ) {
        for ( var i = 0; i < bodies.length; i++ ) {
            var b = bodies[ i ];
            if ( ( b.kind !== 'planet' && b.kind !== 'moon' ) || !b.parent ) continue;
            var parentDist = v3len( v3sub( b.parent.pos, cam.pos ) );
            var R = v3len( v3sub( b.pos, b.parent.pos ) );
            var ringPx = R / Math.max( parentDist, 1 ) * view.pxPerRad;
            var minPx = b.kind === 'moon' ? RING_MIN_PX * 3 : RING_MIN_PX;
            var fade = smoothstep( minPx, minPx * 4, ringPx );
            if ( fade <= 0.01 ) continue;
            var related = selected && ( b === selected || b.parent === selected || selected.parent === b );
            var base = b.kind === 'planet' ? 0.3 : 0.2;
            var rgb = b.kind === 'planet' ? [ 0.35, 0.6, 0.85 ] : [ 0.6, 0.6, 0.62 ];
            count = addRing( lineData, count, b.parent, b, related ? [ 0.6, 0.85, 1 ] : rgb, ( related ? 0.6 : base ) * fade );
            lodCounts.rings++;
        }
    }
    renderer.setLines( lineData, count );
}

// is screen point (x, y) at depth `depth` hidden behind a drawn sphere?
function occluded( b ) {
    for ( var i = 0; i < bodies.length; i++ ) {
        var o = bodies[ i ];
        if ( o === b || !o.drawBody || o.pxR < 3 || o.depth <= 0 ) continue;
        if ( o.dist + o.radius * 0.1 >= b.dist ) continue;
        var dx = b.sx - o.sx, dy = b.sy - o.sy;
        if ( dx * dx + dy * dy < o.pxR * o.pxR * 0.95 ) return true;
    }
    return false;
}

function updateLabels() {
    var candidates = [];
    if ( settings.labels ) {
        for ( var i = 0; i < bodies.length; i++ ) {
            var b = bodies[ i ];
            if ( !( b.drawBody || b.drawMarker ) || b.depth <= 0 ) continue;
            var important = b === selected || b === hovered;
            if ( !important ) {
                if ( b.kind === 'other' ) continue;
                if ( b.parent && b.kind !== 'planet' && b.sepPx < CHILD_LABEL_SEP_PX ) continue;
            }
            if ( b.sx < -50 || b.sx > view.w + 50 || b.sy < -20 || b.sy > view.h + 20 ) continue;
            if ( !important && occluded( b ) ) continue;
            var pri = ( KIND_PRIORITY[ b.kind ] || 0 ) + Math.min( b.pxR, 50 ) * 0.2;
            if ( b === hovered ) pri = 900;
            if ( b === selected ) pri = 1000;
            candidates.push( { body: b, pri: pri, x: b.sx, y: b.sy, offset: Math.max( b.pxR, b.drawMarker ? b.markerPx : 0 ) } );
        }
        if ( settings.sky ) {
            skyGateLabels.forEach( function ( g ) {
                var p = project( g.dir );
                if ( p.z <= 0 ) return;
                if ( p.x < 0 || p.x > view.w || p.y < 0 || p.y > view.h ) return;
                // the sky is behind everything, so any drawn body covers it
                for ( var o = 0; o < bodies.length; o++ ) {
                    var ob = bodies[ o ];
                    if ( !ob.drawBody || ob.depth <= 0 ) continue;
                    var dx = p.x - ob.sx, dy = p.y - ob.sy;
                    if ( dx * dx + dy * dy < ob.pxR * ob.pxR ) return;
                }
                candidates.push( { body: g.gate, sky: true, pri: 5, x: p.x, y: p.y, offset: 4 } );
            } );
        }
    }
    candidates.sort( function ( a, b ) { return b.pri - a.pri; } );

    var placed = [];
    labelRects = [];
    var used = 0;
    for ( var c = 0; c < candidates.length; c++ ) {
        var cand = candidates[ c ];
        var b = cand.body;
        var important = !cand.sky && ( b === selected || b === hovered );
        var text = important ? b.name : ( cand.sky ? '→ ' + b.shortName : b.shortName );
        var sub = important ? fmtDistance( Math.max( b.dist - ( b.hasSphere ? b.radius : 0 ), 0 ) ) : '';
        var wEst = Math.max( text.length, sub.length ) * 6.3 + 6;
        var hEst = sub ? 26 : 14;
        var x = cand.x + cand.offset * 0.72 + 5;
        var y = cand.y - cand.offset * 0.72 - hEst + 4;
        var rect = { x0: x, y0: y, x1: x + wEst, y1: y + hEst };
        var clash = false;
        for ( var k = 0; k < placed.length && !important; k++ ) {
            var r = placed[ k ];
            if ( rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0 ) { clash = true; break; }
        }
        if ( clash ) continue;
        placed.push( rect );
        if ( !cand.sky ) labelRects.push( { body: b, rect: rect } );

        var node = labelPool[ used ];
        if ( !node ) {
            node = document.createElement( 'div' );
            node.className = 'lbl';
            node.innerHTML = '<span class="t"></span><span class="s"></span>';
            el.labels.appendChild( node );
            labelPool.push( node );
        }
        var key = text + '|' + sub + '|' + b.css + '|' + ( cand.sky ? 1 : 0 ) + ( important ? 1 : 0 );
        if ( node._key !== key ) {
            node._key = key;
            node.firstChild.textContent = text;
            node.lastChild.textContent = sub;
            node.style.color = b.css;
            node.className = 'lbl' + ( cand.sky ? ' sky' : '' ) + ( important ? ' hi' : '' ) + ' k-' + b.kind;
        }
        node.style.transform = 'translate(' + Math.round( x ) + 'px,' + Math.round( y ) + 'px)';
        node.style.display = '';
        used++;
    }
    for ( var z = used; z < labelPool.length; z++ ) {
        if ( labelPool[ z ].style.display !== 'none' ) labelPool[ z ].style.display = 'none';
    }
    lodCounts.labels = used;
}

function viewRotation() {
    var r = view.right, u = view.up, b = view.back;
    // column-major world->view: row i of the matrix is camera axis i
    return [ r[ 0 ], u[ 0 ], b[ 0 ], r[ 1 ], u[ 1 ], b[ 1 ], r[ 2 ], u[ 2 ], b[ 2 ] ];
}

var lastTime = performance.now();
var startTime = lastTime;

function frame( now ) {
    requestAnimationFrame( frame );
    var dt = Math.min( ( now - lastTime ) / 1000, 0.1 );
    lastTime = now;

    frameTimes.push( dt );
    if ( frameTimes.length > 60 ) frameTimes.shift();

    resize();
    if ( !sys ) return;

    if ( flight ) updateFlight( dt );
    else updateMovement( dt );
    updateShip( dt );
    if ( !flight ) resolveCollisions();

    computeView();
    updateLod();
    writeSpheres();
    writeMeshes();
    writeMarkers();
    writeRings();
    renderer.setSun( sun ? v3sub( sun.pos, cam.pos ) : [ 0, 0, 0 ] );
    renderer.setFrame( viewRotation(), FOV_Y, NEAR, ( now - startTime ) / 1000 );
    renderer.render();
    updateLabels();

    if ( now - lastHud > 150 ) {
        lastHud = now;
        updateHud();
    }
}

function resize() {
    var w = el.viewport.clientWidth, h = el.viewport.clientHeight;
    var dpr = Math.min( window.devicePixelRatio || 1, 2 );
    if ( w !== view.w || h !== view.h || dpr !== view.dpr ) {
        var dprChanged = dpr !== view.dpr;
        view.w = w; view.h = h; view.dpr = dpr;
        renderer.resize( w * dpr, h * dpr );
        if ( dprChanged ) buildSky();
    }
}

// ------------------------------------------------------------------- UI

function updateHud() {
    var avg = frameTimes.reduce( function ( a, b ) { return a + b; }, 0 ) / Math.max( frameTimes.length, 1 );
    el.fps.textContent = avg > 0 ? Math.round( 1 / avg ) + ' fps' : '';

    var mode;
    if ( flight ) mode = 'Warping to ' + flight.body.name;
    else if ( orbitTarget ) mode = 'Orbiting ' + orbitTarget.name;
    else mode = 'Free flight';
    var speed = flight ? 'warp' : fmtSpeed( cam.currentSpeed || 0 );
    var maxSpeed = Math.max( nearestSurfaceDistance() * 0.8 * cam.speedScale, 20 );
    el.status.textContent = mode + '  ·  ' + speed + '  ·  throttle ' + fmtSpeed( maxSpeed ) +
        ( sun ? '  ·  ' + fmtDistance( v3len( v3sub( cam.pos, sun.pos ) ) ) + ' from star' : '' );
    el.lodStats.textContent = 'LOD: ' + lodCounts.spheres + ' bodies · ' + lodCounts.markers + ' markers · ' +
        lodCounts.labels + ' labels · ' + lodCounts.rings + ' orbits · ' +
        ( lodCounts.rocks ? lodCounts.rocks + ' rocks · ' : '' ) + lodCounts.hidden + ' too small/off-screen';

    if ( selected ) {
        var dEl = document.getElementById( 'infoDistance' );
        if ( dEl ) dEl.textContent = fmtDistance( Math.max( selected.dist - ( selected.hasSphere ? selected.radius : 0 ), 0 ) );
    }
}

function buildSystemHeader() {
    el.systemName.textContent = sys.name;
    var sec = displaySecurity( sys.security );
    el.systemSec.textContent = sec.toFixed( 1 );
    el.systemSec.style.color = secColor( sys.security );
    el.systemLinks.innerHTML =
        '<a href="constellation.php?constellation=' + sys.constellationId + '&system=' + sys.id + '">' + escapeHtml( sys.constellationName || 'Constellation' ) + '</a>' +
        ' · <a href="region.php?region=' + sys.regionId + '">' + escapeHtml( sys.regionName || 'Region' ) + '</a>' +
        ' · <a href="system.php?system=' + sys.id + '">classic view</a>';
}

function treeRow( b, depth ) {
    var row = document.createElement( 'div' );
    row.className = 'row d' + depth + ' k-' + b.kind;
    row.dataset.id = b.id;
    var dot = document.createElement( 'span' );
    dot.className = 'dot';
    dot.style.background = b.css;
    var name = document.createElement( 'span' );
    name.className = 'nm';
    name.textContent = depth > 0 ? b.shortName : ( b.kind === 'gate' ? b.name : b.name );
    name.title = b.name;
    row.appendChild( dot );
    row.appendChild( name );
    if ( b.kind === 'gate' && b.dest ) {
        var sec = document.createElement( 'span' );
        sec.className = 'sec';
        sec.textContent = displaySecurity( b.dest.security ).toFixed( 1 );
        sec.style.color = secColor( b.dest.security );
        row.appendChild( sec );
    }
    row.addEventListener( 'click', function () {
        select( b );
        flyTo( b );
    } );
    return row;
}

function sortChildren( list ) {
    return list.slice().sort( function ( a, b ) {
        var order = { moon: 0, belt: 1, station: 2 };
        if ( a.kind !== b.kind ) return ( order[ a.kind ] || 9 ) - ( order[ b.kind ] || 9 );
        return ( a.orbitIndex || 0 ) - ( b.orbitIndex || 0 ) || a.name.localeCompare( b.name );
    } );
}

function buildTree() {
    el.tree.textContent = '';
    var frag = document.createDocumentFragment();

    function heading( text ) {
        var h = document.createElement( 'div' );
        h.className = 'hd';
        h.textContent = text;
        frag.appendChild( h );
    }

    if ( sun ) {
        heading( 'Star' );
        frag.appendChild( treeRow( sun, 0 ) );
    }

    var planets = bodies.filter( function ( b ) { return b.kind === 'planet'; } )
        .sort( function ( a, b ) { return ( a.celestialIndex || 0 ) - ( b.celestialIndex || 0 ); } );
    if ( planets.length ) heading( 'Planets' );
    planets.forEach( function ( p ) {
        var group = document.createElement( 'div' );
        group.className = 'grp';
        group.appendChild( treeRow( p, 0 ) );
        sortChildren( p.children ).forEach( function ( c ) {
            group.appendChild( treeRow( c, 1 ) );
            sortChildren( c.children ).forEach( function ( s ) {
                group.appendChild( treeRow( s, 2 ) );
            } );
        } );
        frag.appendChild( group );
    } );

    var gates = bodies.filter( function ( b ) { return b.kind === 'gate'; } )
        .sort( function ( a, b ) { return a.shortName.localeCompare( b.shortName ); } );
    if ( gates.length ) heading( 'Stargates' );
    gates.forEach( function ( g ) { frag.appendChild( treeRow( g, 0 ) ); } );

    // anything the tree above didn't reach (e.g. a station orbiting the
    // star directly, or decorative secondary suns)
    var shown = {};
    frag.querySelectorAll( '.row' ).forEach( function ( r ) { shown[ r.dataset.id ] = true; } );
    var rest = bodies.filter( function ( b ) { return !shown[ b.id ]; } );
    if ( rest.length ) heading( 'Other' );
    rest.forEach( function ( b ) { frag.appendChild( treeRow( b, 0 ) ); } );

    el.tree.appendChild( frag );
    applyTreeFilter();
}

function applyTreeFilter() {
    var q = el.treeFilter.value.trim().toLowerCase();
    el.tree.querySelectorAll( '.row' ).forEach( function ( r ) {
        var b = bodyById[ r.dataset.id ];
        r.style.display = !q || b.name.toLowerCase().indexOf( q ) >= 0 ||
            ( b.dest && b.dest.systemName.toLowerCase().indexOf( q ) >= 0 ) ? '' : 'none';
    } );
    el.tree.querySelectorAll( '.hd' ).forEach( function ( h ) { h.style.display = q ? 'none' : ''; } );
}

function statRows( b ) {
    var s = b.stats || {};
    var rows = [];
    if ( b.kind === 'sun' ) {
        if ( s.spectralClass ) rows.push( [ 'Spectral class', s.spectralClass ] );
        if ( s.temperature ) rows.push( [ 'Temperature', Math.round( s.temperature ).toLocaleString() + ' K' ] );
        if ( s.luminosity != null ) rows.push( [ 'Luminosity', s.luminosity.toFixed( 3 ) ] );
    }
    if ( b.radius && b.kind !== 'belt' ) {
        rows.push( [ 'Radius', b.nominal ? '~' + ( b.radius / 1000 ) + ' km (display size - not in SDE)' : Math.round( b.radius / 1000 ).toLocaleString() + ' km' ] );
    }
    if ( b.kind !== 'sun' ) {
        if ( s.temperature ) rows.push( [ 'Temperature', Math.round( s.temperature ).toLocaleString() + ' K' ] );
        if ( s.orbitRadius ) rows.push( [ 'Orbit radius', b.kind === 'planet' ? ( s.orbitRadius / AU ).toFixed( 3 ) + ' AU' : Math.round( s.orbitRadius / 1000 ).toLocaleString() + ' km' ] );
        if ( s.eccentricity != null ) rows.push( [ 'Eccentricity', s.eccentricity.toFixed( 4 ) ] );
        if ( s.orbitPeriod ) rows.push( [ 'Orbit period', fmtDuration( s.orbitPeriod ) ] );
        if ( s.rotationRate ) rows.push( [ 'Rotation period', fmtDuration( s.rotationRate ) + ( s.locked ? ' (tidally locked)' : '' ) ] );
        if ( s.surfaceGravity ) rows.push( [ 'Surface gravity', s.surfaceGravity.toFixed( 2 ) + ' m/s²' ] );
        if ( s.escapeVelocity ) rows.push( [ 'Escape velocity', ( s.escapeVelocity / 1000 ).toFixed( 2 ) + ' km/s' ] );
        if ( s.density ) rows.push( [ 'Density', Math.round( s.density ).toLocaleString() + ' kg/m³' ] );
        if ( s.massDust ) rows.push( [ 'Mass', s.massDust.toExponential( 3 ) + ' kg' ] );
        if ( s.pressure != null && b.kind !== 'belt' ) rows.push( [ 'Surface pressure', s.pressure.toPrecision( 3 ) ] );
    }
    return rows;
}

function renderInfo() {
    var b = selected;
    if ( !b ) {
        el.info.style.display = 'none';
        return;
    }
    el.info.style.display = 'block';
    var html = '<div class="ihd"><span class="dot" style="background:' + escapeHtml( b.css ) + '"></span>' +
        '<span class="iname">' + escapeHtml( b.name ) + '</span><button class="x" id="infoClose" title="Deselect (Esc)">×</button></div>';
    html += '<div class="itype">' + escapeHtml( b.typeName || b.group ) + '</div>';
    html += '<table>';
    html += '<tr><th>Distance</th><td id="infoDistance"></td></tr>';
    if ( b.parent && b.kind !== 'planet' ) html += '<tr><th>Orbits</th><td>' + escapeHtml( b.parent.name ) + '</td></tr>';
    if ( b.dest ) {
        html += '<tr><th>Leads to</th><td><b style="color:' + secColor( b.dest.security ) + '">' +
            escapeHtml( b.dest.systemName ) + ' ' + displaySecurity( b.dest.security ).toFixed( 1 ) + '</b></td></tr>';
    }
    statRows( b ).forEach( function ( r ) {
        html += '<tr><th>' + escapeHtml( r[ 0 ] ) + '</th><td>' + escapeHtml( r[ 1 ] ) + '</td></tr>';
    } );
    html += '</table><div class="btns">';
    html += '<button id="infoFly" title="G">Warp to</button>';
    html += '<button id="infoOrbit" title="O">Orbit</button>';
    if ( b.dest ) html += '<button id="infoJump" class="jump" title="J">Jump to ' + escapeHtml( b.dest.systemName ) + '</button>';
    html += '</div>';
    el.info.innerHTML = html;

    document.getElementById( 'infoClose' ).onclick = function () { select( null ); };
    document.getElementById( 'infoFly' ).onclick = function () { flyTo( b ); };
    document.getElementById( 'infoOrbit' ).onclick = function () { flight = null; orbitTarget = b; };
    var jump = document.getElementById( 'infoJump' );
    if ( jump ) jump.onclick = function () { jumpThrough( b ); };
    updateHud();
}

function select( b ) {
    selected = b;
    el.tree.querySelectorAll( '.row.sel' ).forEach( function ( r ) { r.classList.remove( 'sel' ); } );
    if ( b ) {
        var row = el.tree.querySelector( '.row[data-id="' + b.id + '"]' );
        if ( row ) {
            row.classList.add( 'sel' );
            row.scrollIntoView( { block: 'nearest' } );
        }
    }
    renderInfo();
}

function jumpThrough( gate ) {
    if ( !gate || !gate.dest ) return;
    loadSystem( gate.dest.systemId, { arriveGateId: gate.dest.gateId, push: true } );
}

// ------------------------------------------------------------- picking

function pick( x, y ) {
    for ( var l = labelRects.length - 1; l >= 0; l-- ) {
        var r = labelRects[ l ].rect;
        if ( x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 ) return labelRects[ l ].body;
    }
    var best = null, bestScore = Infinity;
    for ( var i = 0; i < bodies.length; i++ ) {
        var b = bodies[ i ];
        if ( !( b.drawBody || b.drawMarker ) || b.depth <= 0 ) continue;
        var dx = x - b.sx, dy = y - b.sy;
        var d = Math.sqrt( dx * dx + dy * dy );
        var reach = b.drawBody ? Math.max( b.pxR, 7 ) : b.markerPx + 7;
        if ( b.kind === 'sun' ) reach = Math.max( b.pxR, 12 );
        if ( d > reach ) continue;
        // inside a disc the nearest body wins; otherwise the closest marker
        var score = ( b.drawBody && d <= b.pxR ) ? b.dist / 1e30 : 1 + d;
        if ( score < bestScore ) { bestScore = score; best = b; }
    }
    return best;
}

function isUiTarget( t ) {
    return t && t.closest && t.closest( '.ui' );
}

function onPointerDown( e ) {
    if ( isUiTarget( e.target ) ) return;
    pointer.down = true;
    pointer.button = e.button;
    pointer.startX = pointer.lastX = e.clientX;
    pointer.startY = pointer.lastY = e.clientY;
    pointer.dragged = false;
    el.viewport.setPointerCapture( e.pointerId );
    if ( document.activeElement && document.activeElement !== document.body ) document.activeElement.blur();
}

function onPointerMove( e ) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if ( pointer.down ) {
        var dx = e.clientX - pointer.lastX, dy = e.clientY - pointer.lastY;
        pointer.lastX = e.clientX;
        pointer.lastY = e.clientY;
        if ( Math.abs( e.clientX - pointer.startX ) + Math.abs( e.clientY - pointer.startY ) > 4 ) pointer.dragged = true;
        if ( !pointer.dragged ) return;
        if ( flight ) flight = null;
        if ( pointer.button === 0 && orbitTarget ) orbitDrag( dx, dy );
        else lookDrag( dx, dy );
        return;
    }
    if ( !isUiTarget( e.target ) && sys ) {
        var h = pick( e.clientX, e.clientY );
        if ( h !== hovered ) {
            hovered = h;
            el.viewport.style.cursor = h ? 'pointer' : '';
        }
    }
}

function onPointerUp( e ) {
    if ( !pointer.down ) return;
    pointer.down = false;
    if ( !pointer.dragged && e.button === 0 && sys ) {
        var b = pick( e.clientX, e.clientY );
        if ( b ) select( b );
    }
}

function onDoubleClick( e ) {
    if ( isUiTarget( e.target ) || !sys ) return;
    var b = pick( e.clientX, e.clientY );
    if ( b ) {
        select( b );
        flyTo( b );
    }
}

function onWheel( e ) {
    if ( isUiTarget( e.target ) ) return;
    e.preventDefault();
    var dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    if ( flight ) return;
    if ( orbitTarget ) {
        orbitZoom( dy );
    } else {
        cam.speedScale = clamp( cam.speedScale * Math.exp( -dy * 0.0015 ), 0.001, 1000 );
    }
}

function isTyping( e ) {
    var t = e.target;
    return t && ( t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable );
}

function onKeyDown( e ) {
    if ( isTyping( e ) ) {
        if ( e.code === 'Escape' ) e.target.blur();
        return;
    }
    keys[ e.code ] = true;
    if ( [ 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].indexOf( e.code ) >= 0 ) e.preventDefault();

    switch ( e.code ) {
        case 'KeyG': case 'Enter': if ( selected ) flyTo( selected ); break;
        case 'KeyO': if ( selected ) { flight = null; orbitTarget = selected; } break;
        case 'KeyJ': if ( selected && selected.dest ) jumpThrough( selected ); break;
        case 'KeyH': case 'Home': flight = null; placeOverview(); break;
        case 'Escape': if ( flight ) flight = null; else select( null ); break;
        case 'Slash': if ( e.shiftKey ) el.helpPanel.classList.toggle( 'open' ); else { e.preventDefault(); el.treeFilter.focus(); } break;
        case 'KeyL': el.toggleLabels.checked = !el.toggleLabels.checked; syncToggles(); break;
        case 'KeyB': el.toggleOrbits.checked = !el.toggleOrbits.checked; syncToggles(); break;
        case 'KeyV': el.toggleShip.checked = !el.toggleShip.checked; syncToggles(); break;
        case 'KeyN': el.toggleNebula.checked = !el.toggleNebula.checked; syncToggles(); break;
    }
}

function onKeyUp( e ) {
    keys[ e.code ] = false;
}

function syncToggles() {
    settings.orbits = el.toggleOrbits.checked;
    settings.labels = el.toggleLabels.checked;
    settings.sky = el.toggleSky.checked;
    settings.ship = el.toggleShip.checked;
    settings.nebula = el.toggleNebula.checked;
    applyNebula();
    buildSky();
}

// ------------------------------------------------------ universe search

function setupSearch() {
    var timer = null, controller = null;
    el.search.addEventListener( 'input', function () {
        var q = el.search.value.trim();
        clearTimeout( timer );
        if ( q.length < 2 ) {
            el.searchResults.style.display = 'none';
            return;
        }
        timer = setTimeout( function () {
            if ( controller ) controller.abort();
            controller = new AbortController();
            fetch( SEARCH_URL + '?q=' + encodeURIComponent( q ), { signal: controller.signal } )
                .then( function ( r ) { return r.json(); } )
                .then( renderSearch )
                .catch( function () {} );
        }, 200 );
    } );
    el.search.addEventListener( 'keydown', function ( e ) {
        if ( e.key === 'Enter' ) {
            var first = el.searchResults.querySelector( '.res' );
            if ( first ) first.click();
        }
    } );
    document.addEventListener( 'click', function ( e ) {
        if ( e.target !== el.search ) el.searchResults.style.display = 'none';
    } );
}

function renderSearch( items ) {
    el.searchResults.textContent = '';
    if ( !items.length ) {
        el.searchResults.style.display = 'none';
        return;
    }
    items.forEach( function ( it ) {
        var row = document.createElement( 'div' );
        row.className = 'res';
        var tag = document.createElement( 'span' );
        tag.className = 'tag';
        tag.textContent = it.type;
        var name = document.createElement( 'span' );
        name.textContent = it.name;
        row.appendChild( tag );
        row.appendChild( name );
        row.addEventListener( 'click', function () {
            el.searchResults.style.display = 'none';
            el.search.value = '';
            el.search.blur();
            if ( it.type === 'system' ) loadSystem( it.id, { push: true } );
            else if ( it.type === 'constellation' ) location.href = 'constellation.php?constellation=' + it.id;
            else location.href = 'region.php?region=' + it.id;
        } );
        el.searchResults.appendChild( row );
    } );
    el.searchResults.style.display = 'block';
}

// ----------------------------------------------------------------- boot

function queryInt( name ) {
    var v = new URLSearchParams( location.search ).get( name );
    return v && /^\d+$/.test( v ) ? parseInt( v, 10 ) : null;
}

async function boot() {
    try {
        renderer = await Renderer.create( document.getElementById( 'gpu' ) );
    } catch ( err ) {
        el.loading.innerHTML = escapeHtml( err.message ) +
            '<br><small>WebGPU needs a recent Chrome, Edge, Safari 26+ or Firefox 141+ (Windows). ' +
            '<a href="system.php' + location.search + '">Open the classic viewer instead.</a></small>';
        el.loading.style.display = 'block';
        el.fade.classList.remove( 'on' );
        return;
    }

    meshes = {
        station: renderer.createMesh( buildDodecahedron(), 'dodecahedron' ),
        gate: renderer.createMesh( buildTorus( GATE_RING.major, GATE_RING.minor, 72, 16 ), 'stargate ring' ),
        rocks: []
    };
    rifter = buildRifter();
    meshes.ship = renderer.createMesh( rifter.hull, 'rifter hull' );
    meshes.shipEngines = renderer.createMesh( rifter.engines, 'rifter engines' );
    loadShipModel();
    for ( var rv = 0; rv < ROCK_VARIANTS; rv++ ) meshes.rocks.push( renderer.createMesh( buildRock( rv + 1 ), 'rock ' + rv ) );

    el.viewport.addEventListener( 'pointerdown', onPointerDown );
    window.addEventListener( 'pointermove', onPointerMove );
    window.addEventListener( 'pointerup', onPointerUp );
    el.viewport.addEventListener( 'dblclick', onDoubleClick );
    el.viewport.addEventListener( 'wheel', onWheel, { passive: false } );
    el.viewport.addEventListener( 'contextmenu', function ( e ) { e.preventDefault(); } );
    window.addEventListener( 'keydown', onKeyDown );
    window.addEventListener( 'keyup', onKeyUp );
    window.addEventListener( 'blur', function () { keys = {}; } );
    window.addEventListener( 'popstate', function ( e ) {
        var id = e.state && e.state.system ? e.state.system : queryInt( 'system' );
        if ( id ) loadSystem( id, {} );
    } );
    el.treeFilter.addEventListener( 'input', applyTreeFilter );
    [ el.toggleOrbits, el.toggleLabels, el.toggleSky, el.toggleNebula, el.toggleShip ].forEach( function ( t ) { t.addEventListener( 'change', syncToggles ); } );
    el.skyLight.addEventListener( 'input', function () {
        settings.skyLight = parseFloat( el.skyLight.value );
        applySkyLight();
    } );
    applySkyLight();
    document.getElementById( 'helpToggle' ).addEventListener( 'click', function () { el.helpPanel.classList.toggle( 'open' ); } );
    document.getElementById( 'sidebarToggle' ).addEventListener( 'click', function () { el.sidebar.classList.toggle( 'collapsed' ); } );
    setupSearch();

    resize();
    requestAnimationFrame( frame );

    fetchJson( DATA_URL + '?sky=1' ).then( function ( data ) {
        sky = data;
        buildSky();
    } ).catch( function ( err ) { console.warn( 'Sky catalogue unavailable', err ); } );

    loadSystem( queryInt( 'system' ) || 30000142, { focusId: queryInt( 'focus' ) } );
}

boot();
