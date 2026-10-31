/**
 * Interleaved vertex layout shared by the vector batches and static meshes:
 * `x, y, r, g, b, a` floats per vertex.
 */

import type { Color } from "../Color";

export const FLOATS_PER_VERTEX = 6;

export interface SegmentLike {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/**
 * Write one line segment's stroke (two triangles) at `out[vertexOffset * 6]`, returning the number
 * of vertices written (0 for a degenerate segment). Kept allocation-free so the hot batch path and
 * one-shot mesh building share the exact same expansion.
 */
export function writeSegmentVertices(
    segments: readonly SegmentLike[],
    width: number,
    color: Color | undefined,
    out: Float32Array,
    vertexOffset = 0,
): number {
    if (width <= 0) return 0;
    const half = width / 2;
    const r = color ? color.r / 255 : 1;
    const g = color ? color.g / 255 : 1;
    const b = color ? color.b / 255 : 1;
    const a = color ? color.a / 255 : 1;
    let o = vertexOffset * FLOATS_PER_VERTEX;
    let written = 0;
    for (const s of segments) {
        const dx = s.x1 - s.x0;
        const dy = s.y1 - s.y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        const x0n = s.x0 + nx;
        const y0n = s.y0 + ny;
        const x1n = s.x1 + nx;
        const y1n = s.y1 + ny;
        const x0p = s.x0 - nx;
        const y0p = s.y0 - ny;
        const x1p = s.x1 - nx;
        const y1p = s.y1 - ny;
        // two triangles per segment
        out[o++] = x0n;
        out[o++] = y0n;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        out[o++] = x1n;
        out[o++] = y1n;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        out[o++] = x0p;
        out[o++] = y0p;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        out[o++] = x0p;
        out[o++] = y0p;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        out[o++] = x1n;
        out[o++] = y1n;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        out[o++] = x1p;
        out[o++] = y1p;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        written += 6;
    }
    return written;
}
