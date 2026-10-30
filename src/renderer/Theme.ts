/**
 * Color themes.
 *
 * The palettes mirror the game's `ColorThemes.ts`. The world renderer takes its default
 * grid/building/deposit/ring/text colors from the active theme; explicit config colors win.
 */

import { Color } from "../Color";

export interface IColorTheme {
    name: string;
    /** world clear color */
    background: Color;
    /** grid lines */
    grid: Color;
    /** selected-tile outline */
    gridSelected: Color;
    /** buildings, deposits, level digits and overlay text */
    building: Color;
    /** selected building tint */
    buildingSelected: Color;
    /** HQ-only tint */
    hq: Color;
    red: Color;
    orange: Color;
    green: Color;
    /** Panel override colors (UI only, unused by the world layer) */
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

/** Fallbacks used when a theme does not define its overlay gradient endpoints */
const DEFAULT_OVERLAY_MIN = new Color(255, 118, 117, 255);
const DEFAULT_OVERLAY_MAX = new Color(85, 239, 196, 255);

/** The built-in themes, value for value the game's palette */
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

/** Default theme name, matching the game's `COLORS.Blue` */
export const DEFAULT_THEME_NAME = "Blue";

/** Deep copy, so callers never share mutable `Color` objects with the theme table. */
export function cloneTheme(theme: IColorTheme): IColorTheme {
    return {
        name: theme.name,
        background: theme.background.clone(),
        grid: theme.grid.clone(),
        gridSelected: theme.gridSelected.clone(),
        building: theme.building.clone(),
        buildingSelected: theme.buildingSelected.clone(),
        hq: theme.hq.clone(),
        red: theme.red.clone(),
        orange: theme.orange.clone(),
        green: theme.green.clone(),
        panelBackgroundOverride: theme.panelBackgroundOverride?.clone(),
        panelForegroundOverride: theme.panelForegroundOverride?.clone(),
        barBackgroundOverride: theme.barBackgroundOverride?.clone(),
        barForegroundOverride: theme.barForegroundOverride?.clone(),
        dlc: theme.dlc,
        modifierOverlayMin: theme.modifierOverlayMin?.clone(),
        modifierOverlayMax: theme.modifierOverlayMax?.clone(),
    };
}

/** Look up a theme by name; falls back to the default theme. Returns a deep copy. */
export function getTheme(name: string): IColorTheme {
    return cloneTheme(THEMES[name] ?? (THEMES[DEFAULT_THEME_NAME] as IColorTheme));
}

/**
 * Overlay fill color: `value` in [0, 1] interpolated between the theme's gradient
 * endpoints, with the caller-supplied alpha. Pass `out` to avoid allocating per tile.
 */
export function overlayGradient(theme: IColorTheme, value: number, alpha = 60, out?: Color): Color {
    const t = Math.max(0, Math.min(1, value));
    const lo = theme.modifierOverlayMin ?? DEFAULT_OVERLAY_MIN;
    const hi = theme.modifierOverlayMax ?? DEFAULT_OVERLAY_MAX;
    const color = out ?? new Color();
    color.r = Math.round(lo.r + (hi.r - lo.r) * t);
    color.g = Math.round(lo.g + (hi.g - lo.g) * t);
    color.b = Math.round(lo.b + (hi.b - lo.b) * t);
    color.a = alpha;
    return color;
}
