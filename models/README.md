# Models

Meshes loaded by the WebGPU viewer (`gpusystem.js`), in the compact `MSH1`
format written by `tools/stl-to-mesh.py` (see that script for the layout).

## rifter.bin / rifter.json

"Eve Online - Rifter Minmatar Frigate" by **Deamos**
(https://www.thingiverse.com/thing:89274), licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

Changes: converted from STL to `MSH1`, re-oriented to the viewer's axes
(nose toward −Z, +Y up), recentred and scaled to circumradius 1 (the viewer
draws it at the Rifter's SDE radius of 31 m), and engine positions added by
hand in `rifter.json`, since the STL has no separate engine parts.

EVE Online and the Rifter design are the property of CCP hf.

Regenerate with:

```
python3 tools/stl-to-mesh.py Rifter.stl models/rifter --axes=-y,z,-x \
    --engine=-46.9,0,19.5,2.4 --engine=-46.1,16,15,2.0 --engine=-46.1,-16,15,2.0 \
    --engine=-42.5,28,20,1.8 --engine=-42.5,-28,20,1.8 \
    --credit='"Eve Online - Rifter Minmatar Frigate" by Deamos (https://www.thingiverse.com/thing:89274), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Converted to the viewer mesh format, re-oriented and rescaled.'
```
