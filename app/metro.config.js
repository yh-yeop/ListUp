// 모노레포 설정: app 밖에 있는 shared 패키지를 metro 가 따라갈 수 있게 한다.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// 워크스페이스 루트에 호이스팅된 패키지를 중복 해석하지 않도록 한다.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
