/**
 * WebGL2 render device: instanced sprites plus a solid triangle batch.
 *
 * The device survives a lost context (`webglcontextlost` / `webglcontextrestored`): the
 * browser restores the context, this class rebuilds its programs and buffers and re-uploads
 * every texture it created.
 */

import type { Color } from "../Color";
import { Mat3 } from "../Mat3";
import type { SpriteDrawCall } from "../InstanceBuffer";
import { GraphicsBatch } from "./GraphicsBatch";
import { SpriteBatch } from "./SpriteBatch";
import { Texture } from "./Texture";
import { assertTextureSize } from "./RenderDevice";
import type { RenderDevice, RenderTexture, Segment, TextureOptions } from "./RenderDevice";

type Layer = "sprite" | "vector" | null;

export class WebGL2Device implements RenderDevice {
    public readonly kind = "webgl2" as const;
    public onLost: (() => void) | null = null;

    private readonly gl: WebGL2RenderingContext;
    private readonly canvas: EventTarget | null;
    private batch: SpriteBatch;
    private graphics: GraphicsBatch;
    private projection = new Mat3();
    private layer: Layer = null;
    private totals = { drawCalls: 0, instances: 0, triangles: 0 };
    private lost = false;
    private disposed = false;
    /** Textures created by this device, kept so they can be re-uploaded after a context restore. */
    private readonly textures = new Set<Texture>();

    private readonly handleContextLost = (event: Event): void => {
        event.preventDefault();
        if (this.disposed || this.lost) return;
        this.lost = true;
        this.layer = null;
        this.onLost?.();
    };

    private readonly handleContextRestored = (): void => {
        if (this.disposed) return;
        try {
            this.createResources();
            for (const texture of this.textures) texture.reload(this.gl);
            this.lost = false;
        } catch {
            // Stay lost; recover() reports false and the caller can recreate the device.
        }
    };

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;
        this.batch = new SpriteBatch(gl);
        this.graphics = new GraphicsBatch(gl);
        this.setupState();
        const canvas = gl.canvas as EventTarget | null;
        this.canvas = canvas && typeof canvas.addEventListener === "function" ? canvas : null;
        if (this.canvas) {
            this.canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
            this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
        }
    }

    public get isLost(): boolean {
        return this.lost;
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
        if (this.lost) return;
        this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    }

    public beginFrame(clearColor: Color | undefined, projection: Mat3): void {
        if (this.lost) return;
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
        if (this.lost) return;
        if (this.layer === "vector") this.flushVectors();
        if (this.layer === "sprite") this.flushSprites();
        this.layer = null;
    }

    private setupState(): void {
        const gl = this.gl;
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    /** (Re)build programs, VAOs and buffers; GL objects are invalid after a context restore. */
    private createResources(): void {
        this.batch = new SpriteBatch(this.gl);
        this.graphics = new GraphicsBatch(this.gl);
        this.setupState();
        this.layer = null;
    }

    private flushSprites(): void {
        this.batch.flush();
        this.totals.drawCalls += this.batch.drawCalls;
        // `SpriteBatch` accumulates instances for the whole frame, so this is the frame total.
        this.totals.instances = this.batch.instanceCount;
    }

    private flushVectors(): void {
        // Vector vertices are straight alpha, so undo any premultiplied sprite blend.
        this.batch.setStraightBlend();
        this.graphics.flush(this.projection);
        this.totals.drawCalls += this.graphics.drawCalls;
        this.totals.triangles = this.graphics.triangleCount;
    }

    public createTexture(image: TexImageSource, width: number, height: number, options: TextureOptions = {}): RenderTexture {
        if (this.disposed) throw new Error("[renderer] device has been disposed");
        if (this.lost) throw new Error("[renderer] device is lost");
        assertTextureSize(image, width, height);
        const texture = Texture.fromImage(this.gl, image, width, height, options);
        this.textures.add(texture);
        return texture;
    }

    public updateTexture(
        texture: RenderTexture,
        image: TexImageSource,
        width: number,
        height: number,
        options?: TextureOptions,
    ): void {
        const owned = this.ownedTexture(texture);
        if (this.lost) throw new Error("[renderer] device is lost");
        owned.update(this.gl, image, width, height, options);
    }

    public disposeTexture(texture: RenderTexture): void {
        const owned = this.ownedTexture(texture);
        this.textures.delete(owned);
        owned.dispose(this.gl);
    }

    private ownedTexture(texture: RenderTexture): Texture {
        if (texture.kind !== this.kind) {
            throw new Error(`[renderer] texture belongs to the ${texture.kind} backend, not webgl2`);
        }
        if (!(texture instanceof Texture) || !this.textures.has(texture)) {
            throw new Error("[renderer] texture was not created by this device");
        }
        return texture;
    }

    public drawSprite(texture: RenderTexture, call: SpriteDrawCall): void {
        if (this.lost) return;
        if (texture.kind !== this.kind) {
            throw new Error(`[renderer] texture belongs to the ${texture.kind} backend, not webgl2`);
        }
        if (this.layer === "vector") this.flushVectors();
        this.layer = "sprite";
        this.batch.draw(texture as Texture, call);
    }

    public addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void {
        if (this.lost) return;
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        this.graphics.addTriangles(points as number[], color, dx, dy);
    }

    public addSegments(segments: readonly Segment[], width: number, color: Color | undefined): void {
        if (this.lost) return;
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        this.graphics.addSegments(segments, width, color);
    }

    public async recover(): Promise<boolean> {
        if (this.disposed) return false;
        // The browser drives WebGL2 context restore; there is nothing to acquire here.
        return !this.lost;
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.canvas) {
            this.canvas.removeEventListener("webglcontextlost", this.handleContextLost, false);
            this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
        }
        for (const texture of this.textures) texture.dispose(this.gl);
        this.textures.clear();
        this.batch.dispose();
        this.graphics.dispose();
        this.layer = null;
    }
}
