/**
 * WebGL2 render device — the **compatibility backend**.
 *
 * Wraps the existing `SpriteBatch` (instanced, 16 floats/instance) and `GraphicsBatch`
 * (solid triangles). Conservative on purpose: it must run everywhere; aggressive
 * optimisation happens on the WebGPU backend.
 *
 * Adds one correctness behaviour the old inline code lacked: **flush-on-layer-switch**,
 * so the visual order follows the call order (logistics lines over buildings, etc.).
 * Previously both batches were always flushed "all vectors, then all sprites".
 */

import type { Color } from "../Color";
import { Mat3 } from "../Mat3";
import type { SpriteDrawCall } from "../InstanceBuffer";
import { GraphicsBatch } from "./GraphicsBatch";
import { SpriteBatch } from "./SpriteBatch";
import { Texture } from "./Texture";
import type { RenderDevice, RenderTexture, Segment, TextureOptions } from "./RenderDevice";

type Layer = "sprite" | "vector" | null;

export class WebGL2Device implements RenderDevice {
    public readonly kind = "webgl2" as const;

    private readonly batch: SpriteBatch;
    private readonly graphics: GraphicsBatch;
    private projection = new Mat3();
    private layer: Layer = null;
    private totals = { drawCalls: 0, instances: 0, triangles: 0 };

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.batch = new SpriteBatch(gl);
        this.graphics = new GraphicsBatch(gl);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        // non-premultiplied alpha (matches vanilla's Sprite blend 770/771)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    public get drawCalls(): number {
        return this.totals.drawCalls;
    }
    public get instanceCount(): number {
        return this.totals.instances;
    }
    public get triangleCount(): number {
        return this.totals.triangles;
    }

    public resize(pixelWidth: number, pixelHeight: number): void {
        this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    }

    public beginFrame(clearColor: Color | undefined, projection: Mat3): void {
        const gl = this.gl;
        if (clearColor) {
            gl.clearColor(clearColor.r / 255, clearColor.g / 255, clearColor.b / 255, clearColor.a / 255);
        } else {
            gl.clearColor(0, 0, 0, 0);
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.projection.copyFrom(projection);
        this.totals = { drawCalls: 0, instances: 0, triangles: 0 };
        this.batch.begin();
        this.batch.setProjection(projection);
        this.graphics.begin();
        this.layer = null;
    }

    public endFrame(): void {
        if (this.layer === "vector") this.flushVectors();
        if (this.layer === "sprite") this.flushSprites();
        this.layer = null;
    }

    private flushSprites(): void {
        this.batch.flush();
        this.totals.drawCalls += this.batch.drawCalls;
        // Frame-absolute: `SpriteBatch` accumulates its instances for the whole frame and only uploads
        // the newly appended range per flush, so `instanceCount` is the frame total, not a per-flush chunk.
        this.totals.instances = this.batch.instanceCount;
    }

    private flushVectors(): void {
        this.graphics.flush(this.projection);
        this.totals.drawCalls += this.graphics.drawCalls;
        this.totals.triangles = this.graphics.triangleCount;
    }

    public createTexture(image: TexImageSource, width: number, height: number, options: TextureOptions = {}): RenderTexture {
        return Texture.fromImage(this.gl, image, width, height, options);
    }

    public drawSprite(texture: RenderTexture, call: SpriteDrawCall): void {
        if (this.layer === "vector") this.flushVectors();
        this.layer = "sprite";
        this.batch.draw(texture as Texture, call);
    }

    public addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void {
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        this.graphics.addTriangles(points as number[], color, dx, dy);
    }

    public addSegments(segments: readonly Segment[], width: number, color: Color | undefined): void {
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        this.graphics.addSegments(segments, width, color);
    }

    public dispose(): void {
        this.batch.dispose();
        this.graphics.dispose();
    }
}
