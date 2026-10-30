/**
 * Public entry point of the engine.
 *
 * Layers: value types, batch data, the renderer facade, grid geometry, bitmap fonts,
 * asset loading, world generation and the world-layer renderer.
 */

/* ---------------- value types ---------------- */
export { Vec2, v2 } from "./Vec2";
export { Vec3, v3 } from "./Vec3";
export { Color, newColor } from "./Color";
export { Mat3 } from "./Mat3";
export type { Mat3Like } from "./Mat3";

/* ---------------- utilities ---------------- */
export { clampf, clamp01, lerp, normalizeAngle, randf, randi, isEmptyObject } from "./math";
export { log, warn, error, assert, setErrorHook, reportError } from "./log";

/* ---------------- batch data ---------------- */
export { InstanceBuffer, FLOATS_PER_INSTANCE, INSTANCE_ATTRIBS } from "./InstanceBuffer";
export type { SpriteDrawCall } from "./InstanceBuffer";

/* ---------------- renderer ---------------- */
export { Renderer2D, requestedBackend, webgpuAvailable } from "./renderer/Renderer2D";
export type { RendererOptions, RendererBackendChoice } from "./renderer/Renderer2D";
export type {
    RenderDevice,
    RenderTexture,
    Segment,
    TextureOptions,
    TextureSource,
} from "./renderer/RenderDevice";
export { textureSourceSize, assertTextureSize } from "./renderer/RenderDevice";
export { SpriteBatch, BatchList } from "./renderer/SpriteBatch";
export type { Batch } from "./renderer/SpriteBatch";
export { Camera2D } from "./renderer/Camera2D";
export { Texture } from "./renderer/Texture";

/* ---------------- grid geometry ---------------- */
export {
    buildSquareGridLines,
    buildHexGridLines,
    buildHexGridLinesFast,
    gridLineCount,
    hexMetrics,
    hexCornerOffsets,
    hexCenter,
    linesToVertices,
    lineEndpoints,
} from "./renderer/GridGeometry";
export type { LineSegment, VisibleRect, HexMetrics } from "./renderer/GridGeometry";

/* ---------------- tweening ---------------- */
export { TweenManager, easing } from "./Tween";
export type { EasingName, EasingFn, TweenOptions, Tweenable } from "./Tween";

/* ---------------- input ---------------- */
export { InputRouter } from "./renderer/InputRouter";
export type { PointerEventData, WheelEventData, PointerPhase } from "./renderer/InputRouter";

/* ---------------- graphics ---------------- */
export { GraphicsBatch, GRAPHICS_VERTEX_SHADER, GRAPHICS_FRAGMENT_SHADER, FLOATS_PER_VERTEX } from "./renderer/GraphicsBatch";
export {
    strokePolyline,
    strokeSegments,
    triangulatePolygon,
    signedArea,
    circlePath,
    regularPolygonPath,
    roundedRectPath,
    dashSegment,
} from "./renderer/tessellate";
export type { Point, TriangleVertices } from "./renderer/tessellate";

/* ---------------- fonts ---------------- */
export { BitmapFont, buildMonospaceFont, createCanvasFont } from "./renderer/BitmapFont";
export type { Glyph, FontMetrics, LaidOutGlyph, CanvasFontOptions, CanvasFontResult } from "./renderer/BitmapFont";

/* ---------------- asset loading ---------------- */
export { Loader, Atlas, atlasRectToUV } from "./renderer/Loader";
export type { AtlasManifest, AtlasRect, LoaderOptions } from "./renderer/Loader";

/* ---------------- worldgen (matching the game rules) ---------------- */
export { srand, xmur3, sfc32, randOne } from "./worldgen/rng";
export {
    forEachTile,
    tileKey,
    parseTileKey,
    tileToWorld,
    worldToTile,
    hexOffsetToKey,
    squareOffsetToAxial,
} from "./worldgen/gridLayout";
export type { GridKind, TileCoord } from "./worldgen/gridLayout";
export { generateWorld, placeBuildings, depositsToArray } from "./worldgen/generateWorld";
export type { MapSpec, GeneratedWorld, Deposit, BuildingPlacement, GenerateOptions } from "./worldgen/generateWorld";

/* ---------------- world-layer renderer (the game integration point) ---------------- */
export { WorldRenderer, DEFAULT_WORLD_CONFIG } from "./renderer/WorldRenderer";
export type {
    WorldRenderConfig,
    SpriteSource,
    OverlayValueFn,
    OverlayTextFn,
    OverlayText,
    DepositVisual,
    BuildingVisual,
} from "./renderer/WorldRenderer";

/* ---------------- color themes ---------------- */
export { THEMES, getTheme, cloneTheme, overlayGradient, DEFAULT_THEME_NAME } from "./renderer/Theme";
export type { IColorTheme } from "./renderer/Theme";

/* ---------------- BMFont ---------------- */
export { parseBMFont, createBitmapFontFromBMFont, bMFontGlyphToGlyph } from "./renderer/BMFont";
export type { BMFontData, BMFontChar, FontPageRect } from "./renderer/BMFont";
