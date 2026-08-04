'use strict';
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

// Paper.js and jsdom discover their optional Node canvas implementation by
// this historical package name. AIDraw already ships @napi-rs/canvas for all
// headless rendering, so expose that exact runtime instead of adding a second
// native graphics stack.
module.exports = require('@napi-rs/canvas');
