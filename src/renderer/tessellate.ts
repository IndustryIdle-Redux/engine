/**
 * Geometry triangulation and stroke expansion (pure functions, unit-testable).
 *
 * Replaces the capability of Cocos `cc.Graphics`: it does the same thing internally
 * (path → stroke/fill → triangulation → vertices), but **rebuilds on every `stroke()`**
 * -- which is exactly the root cause of the original `drawGrid` doing 10,000 strokes / 70,000 points at 14~23 ms each.
 *
 * Here "geometry generation" and "GPU submission" are completely separated:
 * geometry depends only on the input path (pure functions), so it can be **generated once and cached**,
 * and zooming/panning then only needs a different projection matrix, not a rebuild.
 *
 * Output is uniformly a triangle list (one triangle per 3 vertices), convenient for a single `drawArrays`.
 */

export interface Point {
    x: number;
    y: number;
}

/** Triangle vertex array: [x0,y0, x1,y1, ...] */
export type TriangleVertices = number[];

/* ------------------------------------------------------------------ *
 * Stroke (expand a polyline into a quad strip with width)
 * ------------------------------------------------------------------ */

/**
 * Expand one polyline into a stroke triangle strip.
 *
 * Approach: each segment produces one quad (2 triangles), and adjacent segments are joined with a **miter**;
 * the miter length is limited by `miterLimit`, and beyond that it degrades to a bevel (to avoid spikes at sharp corners).
 *
 * @param points polyline vertices (at least 2 points)
 * @param width line width (pixels)
 * @param closed whether it is closed (last point connects to the first)
 */
export function strokePolyline(
    points: readonly Point[],
    width: number,
    closed = false,
    miterLimit = 4,
): TriangleVertices {
    const out: TriangleVertices = [];
    const n = points.length;
    if (n < 2 || width <= 0) return out;

    const half = width / 2;
    const count = closed ? n : n - 1;

    /** Compute the normal at vertex i (the angle bisector of the two adjacent segment normals) */
    const normalAt = (i: number): { nx: number; ny: number; scale: number } => {
        const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)] as Point;
        const cur = points[i] as Point;
        const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)] as Point;

        const d1x = cur.x - prev.x;
        const d1y = cur.y - prev.y;
        const d2x = next.x - cur.x;
        const d2y = next.y - cur.y;
        const l1 = Math.hypot(d1x, d1y) || 1;
        const l2 = Math.hypot(d2x, d2y) || 1;

        // unit normals of the two segments
        const n1x = -d1y / l1;
        const n1y = d1x / l1;
        const n2x = -d2y / l2;
        const n2y = d2x / l2;

        let nx = n1x + n2x;
        let ny = n1y + n2y;
        const len = Math.hypot(nx, ny);
        if (len < 1e-9) {
            // the two segments point in opposite directions (a 180° reversal): fall back to one segment's normal
            return { nx: n1x, ny: n1y, scale: 1 };
        }
        nx /= len;
        ny /= len;
        // miter magnification factor: keeps the edges on both sides flush
        const cos = nx * n1x + ny * n1y;
        const scale = Math.min(miterLimit, 1 / Math.max(cos, 1e-6));
        return { nx, ny, scale };
    };

    for (let i = 0; i < count; i++) {
        const a = points[i] as Point;
        const b = points[(i + 1) % n] as Point;
        const na = normalAt(i);
        const nb = normalAt(closed ? (i + 1) % n : Math.min(n - 1, i + 1));

        const aox = na.nx * half * na.scale;
        const aoy = na.ny * half * na.scale;
        const box = nb.nx * half * nb.scale;
        const boy = nb.ny * half * nb.scale;

        // the four quad corners: a's left/right and b's left/right
        const ax0 = a.x + aox;
        const ay0 = a.y + aoy;
        const ax1 = a.x - aox;
        const ay1 = a.y - aoy;
        const bx0 = b.x + box;
        const by0 = b.y + boy;
        const bx1 = b.x - box;
        const by1 = b.y - boy;

        // two triangles (keeping the same winding order)
        out.push(ax0, ay0, bx0, by0, ax1, ay1);
        out.push(ax1, ay1, bx0, by0, bx1, by1);
    }
    return out;
}

/** Expand many independent line segments into strokes (used for grid lines) */
export function strokeSegments(
    segments: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>,
    width: number,
): TriangleVertices {
    const out: TriangleVertices = [];
    const half = width / 2;
    for (const s of segments) {
        const dx = s.x1 - s.x0;
        const dy = s.y1 - s.y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        const ax0 = s.x0 + nx;
        const ay0 = s.y0 + ny;
        const ax1 = s.x0 - nx;
        const ay1 = s.y0 - ny;
        const bx0 = s.x1 + nx;
        const by0 = s.y1 + ny;
        const bx1 = s.x1 - nx;
        const by1 = s.y1 - ny;
        out.push(ax0, ay0, bx0, by0, ax1, ay1);
        out.push(ax1, ay1, bx0, by0, bx1, by1);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Fill (ear-clipping triangulation for simple polygons)
 * ------------------------------------------------------------------ */

/** Signed area (positive = counter-clockwise) */
export function signedArea(points: readonly Point[]): number {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i] as Point;
        const b = points[(i + 1) % points.length] as Point;
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}

function pointInTriangle(px: number, py: number, a: Point, b: Point, c: Point): boolean {
    const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
    const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
    const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation for a simple polygon (vertices are expected counter-clockwise; the winding is normalized internally).
 *
 * Complexity O(n²) -- good enough for this project's uses (range circles, selection highlights, hexagon fills, n ≤ a few dozen).
 * If very large polygons ever need filling, switch to a sweep line / monotone decomposition then.
 */
export function triangulatePolygon(points: readonly Point[]): TriangleVertices {
    const out: TriangleVertices = [];
    const n = points.length;
    if (n < 3) return out;

    // normalize to counter-clockwise
    const verts: Point[] = signedArea(points) < 0 ? [...points].reverse() : [...points];
    const indices = verts.map((_, i) => i);

    let guard = 0;
    while (indices.length > 3 && guard++ < n * n) {
        let earFound = false;
        for (let k = 0; k < indices.length; k++) {
            const i0 = indices[(k - 1 + indices.length) % indices.length] as number;
            const i1 = indices[k] as number;
            const i2 = indices[(k + 1) % indices.length] as number;
            const a = verts[i0] as Point;
            const b = verts[i1] as Point;
            const c = verts[i2] as Point;

            // convex corner test (cross product > 0 under counter-clockwise winding)
            const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (cross <= 0) continue;

            // ear test: the triangle contains no other vertex
            let contains = false;
            for (const idx of indices) {
                if (idx === i0 || idx === i1 || idx === i2) continue;
                const p = verts[idx] as Point;
                if (pointInTriangle(p.x, p.y, a, b, c)) {
                    contains = true;
                    break;
                }
            }
            if (contains) continue;

            out.push(a.x, a.y, b.x, b.y, c.x, c.y);
            indices.splice(k, 1);
            earFound = true;
            break;
        }
        if (!earFound) break; // non-simple polygon: give up on the remainder instead of looping forever
    }

    if (indices.length === 3) {
        const a = verts[indices[0] as number] as Point;
        const b = verts[indices[1] as number] as Point;
        const c = verts[indices[2] as number] as Point;
        out.push(a.x, a.y, b.x, b.y, c.x, c.y);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Common primitives
 * ------------------------------------------------------------------ */

/** Rounded rectangle (used for building selection boxes and panel highlights) */
export function roundedRectPath(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    segments = 6,
): Point[] {
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    if (r === 0) {
        return [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
        ];
    }
    const pts: Point[] = [];
    const corners: Array<[number, number, number]> = [
        [x + w - r, y + r, -Math.PI / 2],
        [x + w - r, y + h - r, 0],
        [x + r, y + h - r, Math.PI / 2],
        [x + r, y + r, Math.PI],
    ];
    for (const [cx, cy, start] of corners) {
        for (let i = 0; i <= segments; i++) {
            const a = start + (Math.PI / 2) * (i / segments);
            pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }
    }
    return pts;
}

/** Polyline approximation of a circle (attack ranges, resource dots) */
export function circlePath(cx: number, cy: number, radius: number, segments = 32): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
    }
    return pts;
}

/** Regular polygon (hexagon highlights, direction indicators) */
export function regularPolygonPath(
    cx: number,
    cy: number,
    radius: number,
    sides: number,
    startAngle = 0,
): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i < sides; i++) {
        const a = startAngle + (i / sides) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
    }
    return pts;
}

/** Dashed line: cut a segment into dashes (replaces the original `cc.Graphics.prototype.dashedLine` monkey patch) */
export function dashSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    dashLength = 10,
    gapLength = 20,
): Array<{ x0: number; y0: number; x1: number; y1: number }> {
    const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return out;
    const ux = dx / len;
    const uy = dy / len;
    const step = dashLength + gapLength;
    for (let d = 0; d < len; d += step) {
        const end = Math.min(d + dashLength, len);
        out.push({
            x0: x0 + ux * d,
            y0: y0 + uy * d,
            x1: x0 + ux * end,
            y1: y0 + uy * end,
        });
    }
    return out;
}
