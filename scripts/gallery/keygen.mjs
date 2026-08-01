#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  生成市场 VSIX 签名密钥对（Ed25519）。
 *
 *  用法（在仓库根目录）:
 *    node scripts/gallery/keygen.mjs --out market-key.pem
 *  或:  pnpm gallery:keygen -- --out market-key.pem
 *
 *  私钥写 --out（pkcs8 PEM，mode 0600，已存在则拒写防覆盖）——只存运维机/CI secret，绝不进 repo。
 *  公钥以 JWK x（base64url）打印：内置进客户端 marketplaceSigningKeys.ts，或经
 *  UNIVERSE_GALLERY_SIGNING_KEYS='{"<keyId>": "<x>"}' 注入（本地联调/e2e）。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync, existsSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}
function ok(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`)
}

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
if (outIdx < 0 || args[outIdx + 1] === undefined) die('缺少 --out <pem 输出路径>')
const outPath = resolve(args[outIdx + 1])
const keyIdIdx = args.indexOf('--key-id')
const keyId = keyIdIdx >= 0 ? args[keyIdIdx + 1] : 'market-v1'
if (existsSync(outPath)) die(`输出文件已存在，拒绝覆盖: ${outPath}`)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
writeFileSync(outPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
ok(`私钥已写入 ${outPath}（mode 0600；绝不提交进仓库）`)

const x = publicKey.export({ format: 'jwk' }).x
console.log(`
公钥（JWK x，keyId ${keyId}）:
  ${x}

客户端内置（apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts）:
  '${keyId}': '${x}',

或 env 注入（本地联调 / e2e）:
  UNIVERSE_GALLERY_SIGNING_KEYS={"${keyId}":"${x}"}

发布签名:
  pnpm gallery:publish -- --stage <stageDir> --signing-key-file ${outPath} --key-id ${keyId} <vsix...>
`)
