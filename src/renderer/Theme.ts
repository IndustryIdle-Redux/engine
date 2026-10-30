/**
 * Color theme -- **value-for-value identical** to the game's `shared/domain/ColorThemes.ts`.
 *
 * Extraction method: parse the `IColorTheme` fields of `ColorThemes.ts` directly, with no derivation.
 * Default `color = COLORS.Blue` (see `let color = COLORS.Blue;` in the original file).
 *
 * ### What each entry is used for in rendering (compared against the original)
 *  | Field                | Purpose |
 *  |----------------------|---------|
 *  | `background`         | world-layer clear color |
 *  | `grid`               | grid lines (`Grid.drawGrid`) |
 *  | `gridSelected`       | hexagon highlight of the selected tile (with alpha) |
 *  | `building`           | **buildings, deposits**, level numbers, icons (`makeDeposit` uses this color too) |
 *  | `buildingSelected`   | tint of the selected building |
 *  | `hq`                 | HQ-only color (the HQ special case in `getVisualColor`) |
 *  | `modifierOverlayMin` | **low** end of the overlay gradient |
 *  | `modifierOverlayMax` | **high** end of the overlay gradient |
 */

import { Color } from "../Color";

export interface IColorTheme {
    name: string;
    background: Color;
    grid: Color;
    gridSelected: Color;
    building: Color;
    buildingSelected: Color;
    hq: Color;
    red: Color;
    orange: Color;
    green: Color;
    /** Panel override color (used by the UI, not by the world layer) */
    panelBackgroundOverride?: Color;
    panelForegroundOverride?: Color;
    barBackgroundOverride?: Color;
    barForegroundOverride?: Color;
    /** Whether it is a DLC theme */
    dlc?: boolean;
    /** Low end of the overlay gradient */
    modifierOverlayMin?: Color;
    /** High end of the overlay gradient */
    modifierOverlayMax?: Color;
}

const hex = (s: string): Color => new Color().fromHEX(s);
const COLOR_RED = hex("#e74c3c");
const COLOR_GREEN = hex("#2ecc71");
const COLOR_ORANGE = hex("#f39c12");

/** The 6 themes, exactly matching `ColorThemes.ts` */
export const THEMES: Record<string, IColorTheme> = {
    Blue: {
        name: "Blueprint",
        background: hex("#34495E"),
        grid: hex("4F6376"),
        gridSelected: hex("#f39c12").setA(100),
        building: hex("#ffffff"),
        buildingSelected: hex("#f39c12"),
        hq: hex("#74b9ff"),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        panelBackgroundOverride: hex("#ffffff"),
        panelForegroundOverride: hex("#33333"),
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
    Black: {
        name: "Monokai",
        background: hex("#272822"),
        grid: hex("#4C4E44"),
        gridSelected: hex("#A1E245").setA(100),
        building: hex("#f8f8f2"),
        buildingSelected: hex("#A1E245"),
        hq: hex("#FF2773"),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
    Dracula: {
        name: "Dracula",
        background: hex("#282a36"),
        grid: hex("#4F515C"),
        gridSelected: hex("#8be9fd").setA(100),
        building: hex("#f8f8f2"),
        buildingSelected: hex("#8be9fd"),
        hq: hex("#bd93f9"),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        dlc: true,
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
    SolarizedLight: {
        name: "Solarized Light",
        background: hex("#FDF6E3"),
        grid: hex("#EEE8D5"),
        gridSelected: hex("#D33682").setA(100),
        building: hex("#657B83"),
        buildingSelected: hex("#D33682"),
        hq: hex("#268BD2"),
        barBackgroundOverride: hex("#073642"),
        barForegroundOverride: hex("#FDF6E3"),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
    SolarizedDark: {
        name: "Solarized Dark",
        background: hex("#002B36"),
        grid: hex("#1C4651"),
        gridSelected: hex("#D33682").setA(150),
        building: hex("#93A1A1"),
        buildingSelected: hex("#D33682"),
        hq: hex("#268BD2"),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
    GithubLight: {
        name: "Github Light",
        background: new Color(255, 255, 255, 255),
        grid: new Color(225, 228, 232, 255),
        gridSelected: new Color(0, 92, 197, 150),
        building: new Color(36, 41, 46, 255),
        buildingSelected: new Color(111, 66, 193, 255),
        hq: new Color(111, 66, 193, 255),
        red: COLOR_RED,
        green: COLOR_GREEN,
        orange: COLOR_ORANGE,
        modifierOverlayMin: hex("#ff7675"),
        modifierOverlayMax: hex("#55efc4"),
    },
};

/** Default theme, matching the game's `let color = COLORS.Blue` */
export const DEFAULT_THEME_NAME = "Blue";

export function getTheme(name: string): IColorTheme {
    return THEMES[name] ?? (THEMES[DEFAULT_THEME_NAME] as IColorTheme);
}

/**
 * Overlay gradient color: `value ∈ [0,1]` interpolated between `modifierOverlayMin → Max`.
 *
 * Matches the original `World.getTileModifier`, which colors tiles with a chroma gradient.
 * `alpha` is supplied by the caller (the original uses the overlay opacity).
 */
export function overlayGradient(theme: IColorTheme, value: number, alpha = 60): Color {
    const t = Math.max(0, Math.min(1, value));
    const a = theme.modifierOverlayMin ?? new Color(255, 118, 117, 255);
    const b = theme.modifierOverlayMax ?? new Color(85, 239, 196, 255);
    return new Color(
        Math.round(a.r + (b.r - a.r) * t),
        Math.round(a.g + (b.g - a.g) * t),
        Math.round(a.b + (b.b - a.b) * t),
        alpha,
    );
}
