# Industry Idle engine

A small 2D rendering engine written for [Industry Idle](https://github.com/fishpondstudio/IndustryIdle)'s
de-Cocos branch: WebGPU and WebGL2 back ends behind one interface, instanced sprite batching, a
per-vertex-colour graphics batch, bitmap fonts, hex/square grid geometry, input routing and the map
generator.

Plain TypeScript, no runtime dependencies. The package exposes its `src` directly, so it is consumed
from a workspace or a bundler that compiles TypeScript.

## Layout

```
src/
├── Vec2.ts Vec3.ts Color.ts Mat3.ts   value types
├── InstanceBuffer.ts                  instance packing for sprites
├── Tween.ts                           tweens and easings
├── math.ts log.ts                     helpers
├── renderer/
│   ├── RenderDevice.ts                backend seam
│   ├── WebGL2Device.ts                WebGL2 backend
│   ├── WebGPUDevice.ts                WebGPU backend
│   ├── Renderer2D.ts                  facade: canvas, DPR, frame
│   ├── SpriteBatch.ts                 instanced sprites
│   ├── GraphicsBatch.ts               per-vertex-colour triangles
│   ├── tessellate.ts                  triangulation and stroking
│   ├── GridGeometry.ts                hex and square grid lines
│   ├── Camera2D.ts                    camera, screen/world conversion, culling
│   ├── BitmapFont.ts BMFont.ts        bitmap text
│   ├── WorldRenderer.ts               map assembly: grid, deposits, buildings, overlay
│   ├── InputRouter.ts                 pointer, wheel and pinch input
│   ├── Loader.ts                      atlas loading
│   ├── Texture.ts                     GPU texture
│   └── Theme.ts                       default colour themes
└── worldgen/                          map generation
```

## Usage

```ts
import { Color, Renderer2D } from "@industry-idle/engine";

const renderer = await Renderer2D.create(canvas); // WebGPU when available, WebGL2 otherwise
renderer.begin(new Color(24, 24, 28));
renderer.drawLine(0, 0, 100, 100, 2);
renderer.end();
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # ESM library build
npm run bench:grid  # CPU grid-geometry benchmark (optional)
```

Requires Node 20 or newer.

## Notes

- Extracted from the Industry Idle repo, which is GPL-3.0. This code is derivative and stays under the
  same license.
- The API is still moving. It is shaped around one game, and a few modules (themes, worldgen) encode
  that game's rules.
- Assets (atlases, bitmap fonts, maps) live in the game repository; this repo only ships code.
