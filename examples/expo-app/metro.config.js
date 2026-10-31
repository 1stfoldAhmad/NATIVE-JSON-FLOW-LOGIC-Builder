// Metro must be able to bundle vds-json-logic, which is linked via file:../..
// (a symlink into the package repository root).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const packageRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), packageRoot];

module.exports = config;
