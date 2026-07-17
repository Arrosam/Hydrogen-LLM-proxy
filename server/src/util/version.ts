import pkg from "../../package.json";

/**
 * The running server's version, read from package.json at build time (esbuild
 * inlines it) rather than restated in code. A backup package carries this stamp,
 * and a stamp that has drifted from the real build is worse than none: it is a
 * confident wrong answer at exactly the moment someone is trying to work out
 * which version wrote the file they are restoring.
 */
export const APP_VERSION: string = pkg.version;
