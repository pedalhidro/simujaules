#!/usr/bin/env node
// Builds landuse/index.html from index.src.html by inlining Leaflet 1.9.4's
// stylesheet: the published page may only load stylesheets from Google Fonts
// (the artifact CSP), and the script itself comes from cdnjs with SRI.
// The image url() rules (layer-switcher and default-marker icons, which the
// page never uses) are stripped so no blocked image load is attempted.
//   node build-page.mjs              fetch the CSS from cdnjs
//   node build-page.mjs leaflet.css  use a local copy
import { readFileSync, writeFileSync } from "fs";

const CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
let css = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await (await fetch(CSS_URL)).text();
css = css
  .replace(/background-image:url\(images\/[^)]*\);?/g, "")
  .replace(/behavior:url\(#default#VML\);?/g, "")
  .replace(/\.leaflet-default-icon-path\{[^}]*\}/g, "");
if (/url\(/.test(css)) throw new Error("unexpected url() left in the Leaflet CSS");
const src = readFileSync(new URL("./index.src.html", import.meta.url), "utf8");
if (!src.includes("/*LEAFLET_CSS*/")) throw new Error("placeholder /*LEAFLET_CSS*/ missing from index.src.html");
writeFileSync(new URL("./index.html", import.meta.url),
  src.replace("/*LEAFLET_CSS*/", `/* Leaflet 1.9.4 (BSD-2-Clause) — inlined by build-page.mjs, do not edit here */\n${css}`));
console.log("landuse/index.html written");
