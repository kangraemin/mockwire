'use strict';
const { createMockwire } = require('./server.js');
const { ValidationError, normalizeRule } = require('./rules.js');
module.exports = { createMockwire, ValidationError, normalizeRule };
