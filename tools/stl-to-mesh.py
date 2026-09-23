#!/usr/bin/env python3
"""Convert an STL model into the compact mesh format gpusystem.js loads.

    python3 tools/stl-to-mesh.py Rifter.stl models/rifter \
        --axes=-y,z,-x --engine=-46.6,0,19,2.2 ... --credit="..."

writes models/rifter.bin and models/rifter.json.

--axes maps the model's axes onto the viewer's (nose toward -Z, +Y up):
each entry is the source axis (optionally negated) for viewer X, Y, Z. The
mapping must be a proper rotation (determinant +1) or the triangle winding
would flip; the script refuses reflections.

--engine takes x,y,z,radius in the STL's own units and coordinates, and can
be repeated; they are transformed with the mesh and written to the JSON so
the viewer can put engine glows there (STLs carry no parts or materials).

The mesh is recentred on its bounding box and scaled so its furthest vertex
is at distance 1, then stored as:
    'MSH1', uint32 vertexCount, uint32 indexCount,
    int16 positions[vertexCount * 3] (value / 32767, padded to 4 bytes),
    uint16 or uint32 indices[indexCount] (uint32 when vertexCount > 65535)
all little-endian. Normals are not stored; the viewer flat-shades from the
triangle winding (counter-clockwise seen from outside, as STL requires).
"""

import argparse
import json
import math
import re
import struct
import sys


def read_stl(path):
    data = open(path, 'rb').read()
    head = data[:1024]
    if head.lstrip().startswith(b'solid') and b'facet' in head:
        verts = re.findall(rb'vertex\s+(\S+)\s+(\S+)\s+(\S+)', data)
        pts = [(float(x), float(y), float(z)) for x, y, z in verts]
    else:
        count = struct.unpack_from('<I', data, 80)[0]
        pts = []
        for i in range(count):
            off = 84 + i * 50 + 12
            for v in range(3):
                pts.append(struct.unpack_from('<3f', data, off + v * 12))
    if len(pts) % 3:
        sys.exit('STL vertex count is not a multiple of 3')
    return pts


def parse_axes(spec):
    names = {'x': 0, 'y': 1, 'z': 2}
    axes = []
    for part in spec.split(','):
        part = part.strip()
        sign = -1 if part.startswith('-') else 1
        axes.append((names[part.lstrip('+-')], sign))
    m = [[0] * 3 for _ in range(3)]
    for row, (src, sign) in enumerate(axes):
        m[row][src] = sign
    det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
           - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
           + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
    if det != 1:
        sys.exit('--axes must be a rotation (determinant +1), got %d' % det)
    return lambda p: tuple(sign * p[src] for src, sign in axes)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stl')
    ap.add_argument('out', help='output path without extension')
    ap.add_argument('--axes', default='x,y,z')
    ap.add_argument('--engine', action='append', default=[], help='x,y,z,radius in STL coordinates')
    ap.add_argument('--credit', default='')
    args = ap.parse_args()

    xf = parse_axes(args.axes)
    pts = [xf(p) for p in read_stl(args.stl)]

    lo = [min(p[a] for p in pts) for a in range(3)]
    hi = [max(p[a] for p in pts) for a in range(3)]
    centre = [(lo[a] + hi[a]) / 2 for a in range(3)]
    radius = max(math.dist(p, centre) for p in pts)

    unique, index = {}, []
    for p in pts:
        q = tuple(max(-32767, min(32767, round((p[a] - centre[a]) / radius * 32767))) for a in range(3))
        if q not in unique:
            unique[q] = len(unique)
        index.append(unique[q])
    # drop triangles that quantisation collapsed
    tris = [index[i:i + 3] for i in range(0, len(index), 3)]
    tris = [t for t in tris if len(set(t)) == 3]
    index = [i for t in tris for i in t]

    verts = sorted(unique, key=unique.get)
    wide = len(verts) > 65535
    with open(args.out + '.bin', 'wb') as f:
        f.write(b'MSH1')
        f.write(struct.pack('<II', len(verts), len(index)))
        for v in verts:
            f.write(struct.pack('<3h', *v))
        if (len(verts) * 6) % 4:
            f.write(b'\0\0')
        f.write(struct.pack('<%d%s' % (len(index), 'I' if wide else 'H'), *index))

    engines = []
    for e in args.engine:
        x, y, z, r = (float(s) for s in e.split(','))
        p = xf((x, y, z))
        engines.append({
            'pos': [round((p[a] - centre[a]) / radius, 5) for a in range(3)],
            'radius': round(r / radius, 5)
        })

    meta = {
        'mesh': args.out.rsplit('/', 1)[-1] + '.bin',
        'vertices': len(verts),
        'triangles': len(index) // 3,
        'sourceSize': [round(hi[a] - lo[a], 3) for a in range(3)],
        'engines': engines,
        'credit': args.credit
    }
    with open(args.out + '.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('%d vertices, %d triangles -> %s.bin / %s.json' % (len(verts), len(index) // 3, args.out, args.out))


if __name__ == '__main__':
    main()
