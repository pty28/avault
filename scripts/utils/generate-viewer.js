#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read dmm-library.json
const libraryPath = path.join(__dirname, '../../data/dmm-library.json');
const dmmData = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));

// Read vrack-library.json (optional)
const vrackLibraryPath = path.join(__dirname, '../../data/vrack-library.json');
let vrackData = [];
try {
    vrackData = JSON.parse(fs.readFileSync(vrackLibraryPath, 'utf-8'));
    console.log(`📥 vrack-library.json を読み込みました (${vrackData.length}件)`);
} catch (e) {
    console.log(`⚠️  vrack-library.json が見つかりません（スキップ）`);
}

// Read mgstage-library.json (optional)
const mgstageLibraryPath = path.join(__dirname, '../../data/mgstage-library.json');
let mgstageData = [];
try {
    mgstageData = JSON.parse(fs.readFileSync(mgstageLibraryPath, 'utf-8'));
    console.log(`📥 mgstage-library.json を読み込みました (${mgstageData.length}件)`);
} catch (e) {
    console.log(`⚠️  mgstage-library.json が見つかりません（スキップ）`);
}

// Read caribbean-library.json (optional)
const caribbeanLibraryPath = path.join(__dirname, '../../data/caribbean-library.json');
let caribbeanData = [];
try {
    caribbeanData = JSON.parse(fs.readFileSync(caribbeanLibraryPath, 'utf-8'));
    console.log(`📥 caribbean-library.json を読み込みました (${caribbeanData.length}件)`);
} catch (e) {
    console.log(`⚠️  caribbean-library.json が見つかりません（スキップ）`);
}

// Add source field to DMM data
const dmmDataWithSource = dmmData.map(item => ({ ...item, source: 'dmm' }));

// Normalize VRACK data: playerUrl (singular) → playerUrls (array), derive source from productCode prefix
const normalizedVrackData = vrackData.map(item => {
    const prefix = item.productCode ? item.productCode.split('_')[0] : 'heydouga';
    const source = ['heyzo', '1pondo'].includes(prefix) ? prefix : 'heydouga';
    const normalized = { ...item, source };
    if (item.playerUrl && !item.playerUrls) {
        const { playerUrl, ...rest } = normalized;
        return { ...rest, playerUrls: [playerUrl] };
    }
    return normalized;
});

// Add source field to MGStage data
const mgstageDataWithSource = mgstageData.map(item => ({ ...item, source: 'mgstage' }));

// Add source field to Caribbean data
const caribbeanDataWithSource = caribbeanData.map(item => ({ ...item, source: 'caribbean' }));

// Merge all datasets
const data = [...dmmDataWithSource, ...normalizedVrackData, ...mgstageDataWithSource, ...caribbeanDataWithSource];

/**
 * </script> や U+2028/U+2029 をエスケープして JS リテラルに安全に埋め込む。
 */
function safeJsonForScript(value) {
    return JSON.stringify(value, null, 2)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// Generate viewer-data.js in contents folder
const contentsFolderPath = path.join(__dirname, '../../contents');
if (!fs.existsSync(contentsFolderPath)) {
    fs.mkdirSync(contentsFolderPath, { recursive: true });
}
const viewerDataPath = path.join(contentsFolderPath, 'viewer-data.js');
const jsContent = `const DATA = ${safeJsonForScript(data)};`;

fs.writeFileSync(viewerDataPath, jsContent, 'utf-8');

// Generate presets-data.js from presets.json
const presetsPath = path.join(__dirname, '../../contents/presets.json');
const presetsDataPath = path.join(contentsFolderPath, 'presets-data.js');
try {
    const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
    const presetsJsContent = `const PRESETS = ${safeJsonForScript(presets)};`;
    fs.writeFileSync(presetsDataPath, presetsJsContent, 'utf-8');
    console.log(`✅ presets-data.js を生成しました`);
} catch (e) {
    // presets.json がなければ空配列で生成
    fs.writeFileSync(presetsDataPath, 'const PRESETS = [];', 'utf-8');
    console.log(`⚠️  presets.json が見つからないため空のプリセットで生成しました`);
}

// Generate tag-definitions-data.js from tag-definitions.json
const tagDefsPath = path.join(__dirname, '../../contents/tag-definitions.json');
const tagDefsDataPath = path.join(contentsFolderPath, 'tag-definitions-data.js');
try {
    const tagDefs = JSON.parse(fs.readFileSync(tagDefsPath, 'utf-8'));
    const tagDefsJsContent = `const TAG_DEFINITIONS = ${safeJsonForScript(tagDefs)};`;
    fs.writeFileSync(tagDefsDataPath, tagDefsJsContent, 'utf-8');
    console.log(`✅ tag-definitions-data.js を生成しました`);
} catch (e) {
    fs.writeFileSync(tagDefsDataPath, 'const TAG_DEFINITIONS = [];', 'utf-8');
    console.log(`⚠️  tag-definitions.json が見つからないため空のタグ定義で生成しました`);
}

// Generate tags-data.js from tags.json
const tagsPath = path.join(__dirname, '../../contents/tags.json');
const tagsDataPath = path.join(contentsFolderPath, 'tags-data.js');
try {
    const tags = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));
    const tagsJsContent = `const TAGS = ${safeJsonForScript(tags)};`;
    fs.writeFileSync(tagsDataPath, tagsJsContent, 'utf-8');
    console.log(`✅ tags-data.js を生成しました`);
} catch (e) {
    fs.writeFileSync(tagsDataPath, 'const TAGS = {};', 'utf-8');
    console.log(`⚠️  tags.json が見つからないため空のタグデータで生成しました`);
}

// Statistics
const totalItems = data.length;
const itemsWithActresses = data.filter(item => item.actresses && item.actresses.length > 0).length;
const fileSizeKB = (jsContent.length / 1024).toFixed(2);

console.log(`✅ viewer-data.js を生成しました`);
console.log(`📊 総アイテム数: ${totalItems}件 (DMM: ${dmmData.length}件 + VRACK: ${vrackData.length}件 + MGStage: ${mgstageData.length}件 + カリビアン: ${caribbeanData.length}件)`);
console.log(`👤 女優情報あり: ${itemsWithActresses}件`);
console.log(`📁 ファイルサイズ: ${fileSizeKB} KB`);
console.log(`📍 保存先: ${viewerDataPath}`);
