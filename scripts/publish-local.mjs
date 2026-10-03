// 把打包产物镜像到工作区外的干净目录（默认 D:\Apps\LogicReader，可用 LR_PUBLISH_DIR 覆盖）。
// 为什么必须这么做：Codex 沙箱给工作区根目录打了 Low 完整性标签（见 避坑指南 §2.12），
// 工作区内任何 exe 双击都会以低完整性运行，Chromium 在 JS 执行前崩溃（0x80000003）。
// robocopy 默认 /COPY:DAT 不带 ACL，目标文件继承目标父目录的干净权限，标签不会跟过去。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'release', 'win-unpacked')
const dst = process.env.LR_PUBLISH_DIR || 'D:\\Apps\\LogicReader'
const exe = join(dst, 'LogicReader.exe')

if (!existsSync(join(src, 'LogicReader.exe'))) {
  console.error('未找到打包产物，请先执行 pnpm build:unpack')
  process.exit(1)
}

// robocopy 退出码 0-7 都算成功（>=8 才是失败），不能用 execFileSync 的默认判定
let code = 0
try {
  execFileSync('robocopy', [src, dst, '/MIR', '/NFL', '/NDL', '/NJH', '/NP'], { stdio: 'inherit' })
} catch (error) {
  code = typeof error.status === 'number' ? error.status : 8
}
if (code > 7) {
  console.error('robocopy 失败，退出码 ' + code)
  process.exit(1)
}

// 校验：目标 exe 不得带 Low 完整性标签；icacls 输出是 GBK，但标签名是纯 ASCII，总能匹配
let acl = ''
try {
  acl = execFileSync('icacls', [exe], { encoding: 'utf8' })
} catch {
  acl = ''
}
if (acl.indexOf('Low Mandatory Level') >= 0) {
  console.error('目标 exe 仍带 Low 完整性标签，请检查目标目录：' + dst)
  process.exit(1)
}

console.log('已发布到 ' + dst + '（权限与完整性标签干净，双击即可运行）')
