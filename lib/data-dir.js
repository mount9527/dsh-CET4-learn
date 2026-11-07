/**
 * 题库目录解析（宿主与构建脚本共用一份规则）。
 *
 * 为什么不在插件目录里放 data/：
 *   插件装好之后位于 <profile>/node_modules/dsh-cet4/，`npm update` 或重装会整目录替换，
 *   用户辛苦构建的题库会被连根带走；而且往 node_modules 里写文件本身也不合规矩。
 *   所以题库默认落在用户目录：~/.dsh/dsh-cet4/data
 *
 * 解析优先级：
 *   1. 环境变量 CET4_DATA（指向 data 目录本身）
 *   2. 用户目录 ~/.dsh/dsh-cet4/data（已生成题库时生效）
 *   3. 插件目录内的 data/（只用于本项目开发；发布包里没有这个目录）
 *   4. 插件目录内的 starter/（随包分发的开放示例题库：原创样卷 + 开放词表，
 *      不含任何真题/录音，所以可以公开分发。装完即用就靠它）
 *   5. 都没有 → 仍然返回用户目录，由调用方报“题库未生成”
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（lib/ 的上一级） */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const hasIndex = (p) => {
  try {
    return fs.statSync(path.join(p, 'index.json')).isFile()
  } catch {
    return false
  }
}

/** 用户目录下的题库位置（构建默认写这里） */
export function userDataDir() {
  return path.join(os.homedir(), '.dsh', 'dsh-cet4', 'data')
}

/** 构建默认输出目录：CET4_DATA 优先，否则用户目录 */
export function defaultDataDir() {
  return process.env.CET4_DATA ? path.resolve(process.env.CET4_DATA) : userDataDir()
}

/** 随包分发的示例题库（原创内容，可公开分发） */
export function starterDir() {
  return path.join(PLUGIN_ROOT, 'starter')
}

/**
 * 运行时解析：返回 { dir, source, searched }
 *   source: 'env' | 'user' | 'plugin' | 'starter' | 'missing'
 */
export function resolveDataDir() {
  const env = process.env.CET4_DATA ? path.resolve(process.env.CET4_DATA) : ''
  const user = userDataDir()
  const local = path.join(PLUGIN_ROOT, 'data')
  const starter = starterDir()
  const searched = [env, user, local, starter].filter(Boolean)

  if (env) return { dir: env, source: 'env', searched }
  if (hasIndex(user)) return { dir: user, source: 'user', searched }
  if (hasIndex(local)) return { dir: local, source: 'plugin', searched }
  if (hasIndex(starter)) return { dir: starter, source: 'starter', searched }
  if (isDir(user)) return { dir: user, source: 'user', searched }
  return { dir: user, source: 'missing', searched }
}

/** 构建缓存（PDF 抽取文本）跟题库放在一起，别写进插件目录 */
export function cacheDir() {
  return path.join(path.dirname(defaultDataDir()), '.cache')
}
