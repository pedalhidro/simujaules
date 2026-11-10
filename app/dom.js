// DOM handles used across the app (status line, run button, progress bar…).
import "./compute-source.js"; // evaluation order — see ../app.js

// ------- Shared DOM handles -------
export const demFile = document.getElementById("dem-file");
export const demMeta = document.getElementById("dem-meta");
export const status = document.getElementById("status");
export const runBtn = document.getElementById("run");
export const progress = document.getElementById("progress");
export const progressBar = progress.querySelector(".bar");
export const resultMeta = document.getElementById("result-meta");
