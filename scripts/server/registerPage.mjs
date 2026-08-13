/*---------------------------------------------------------------------------------------------
 *  publisher 自助注册页（GET <base>gallery/register）：完整 HTML 以字符串内嵌，
 *  CSS/JS 全部内联、零外部资源——dist/server.js 是单文件部署形态，不能引入静态目录。
 *  主题与下载页（download-page/index.html）共用一套深色令牌，见 pageStyles.mjs。
 *
 *  安全约定：publisher/token 的字符集虽已被服务端约束（正则/base64url），页面层不依赖
 *  该假设——所有动态数据插入 DOM 一律走 textContent / input.value，绝不拼 innerHTML。
 *--------------------------------------------------------------------------------------------*/

import { PAGE_BASE_CSS } from './pageStyles.mjs'

export function registerPageHtml(base) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>注册发布者 · Universe 扩展市场</title>
<style>${PAGE_BASE_CSS}
  .card { max-width: 560px; margin-top: 32px; padding: 28px 32px 32px; }
  .intro { font-size: 13px; line-height: 1.7; color: var(--muted); margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 0; }
  .hint { font-weight: 400; color: var(--muted); font-size: 12px; }
  button { margin-top: 18px; padding: 9px 18px; font-size: 14px; }
  button.ghost { margin-left: 8px; }
  .error { color: #ff7b72; font-size: 13px; margin: 12px 0 0; }
  .warn {
    color: #ff7b72; font-weight: 700; font-size: 14px; line-height: 1.6;
    border: 1px solid rgba(207, 34, 46, 0.4); border-radius: 8px; padding: 10px 12px;
    background: rgba(207, 34, 46, 0.08);
  }
  .ok { color: var(--ok); font-size: 13px; margin: 10px 0 0; }
</style>
</head>
<body>
<main class="card">
  <a class="back" href="../">&larr; 返回下载页</a>
  <h1>注册发布者</h1>
  <p class="intro">
    注册即获得发布 token；<strong>token 即身份</strong>，请妥善保管。
    注册需管理员审批通过后才能发布扩展。
    通过该 token 发布的扩展将以近乎原生权限运行在用户的编辑器中，请对发布内容负责。
  </p>

  <form id="form" novalidate>
    <label for="publisher">发布者名（必填）</label>
    <input id="publisher" maxlength="64" autocomplete="off" spellcheck="false"
      placeholder="例如 acme">
    <span class="hint">小写字母 / 数字 / 连字符，不能以连字符开头，最长 64 字符</span>

    <label for="email">邮箱（可选）</label>
    <input id="email" type="email" autocomplete="off" placeholder="a@b.c">
    <span class="hint">仅落库供运维联系，不会公开展示</span>

    <label for="label">token 备注（可选）</label>
    <input id="label" maxlength="64" autocomplete="off" placeholder="例如 zhangsan-laptop">
    <span class="hint">标记这张 token 的用途/设备，便于日后吊销；留空默认为 web-register</span>

    <p id="form-error" class="error" hidden></p>
    <button type="submit">注册并获取 token</button>
  </form>

  <section id="result" hidden>
    <p class="warn">token 只显示这一次，请立即保存；丢失只能联系运维吊销后重发。</p>
    <p id="approval-tip" class="ok" style="color:var(--warn)">
      注册已提交，<strong>待管理员审批</strong>。审批通过前发布会提示 pending；
      可用 uex whoami 随时查询审批状态。
    </p>
    <label for="token">你的发布 token</label>
    <input id="token" readonly>
    <label for="command">登录命令（registry 已按本站地址预拼）</label>
    <input id="command" readonly>
    <div>
      <button id="copy-token" type="button">复制 token</button>
      <button id="copy-command" type="button" class="ghost">复制登录命令</button>
    </div>
    <p id="copy-tip" class="ok" hidden></p>
  </section>

  <section id="failure" hidden>
    <p id="failure-msg" class="error"></p>
    <button id="retry" type="button" class="ghost">返回修改</button>
  </section>
</main>
<script>
'use strict'
var BASE = ${JSON.stringify(base)}
var $ = function (id) { return document.getElementById(id) }
var form = $('form')
var resultView = $('result')
var failureView = $('failure')
var formError = $('form-error')

function showError(msg) {
  formError.textContent = msg
  formError.hidden = !msg
}

function copyText(text, tip) {
  var done = function () {
    tip.textContent = '已复制到剪贴板'
    tip.hidden = false
    setTimeout(function () { tip.hidden = true }, 2000)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done) })
  } else {
    fallbackCopy(text, done)
  }
}

function fallbackCopy(text, done) {
  var tmp = document.createElement('textarea')
  tmp.value = text
  document.body.appendChild(tmp)
  tmp.select()
  try { document.execCommand('copy') } catch (e) { /* 用户手动复制即可 */ }
  document.body.removeChild(tmp)
  done()
}

form.addEventListener('submit', function (e) {
  e.preventDefault()
  showError('')
  var publisher = $('publisher').value.trim()
  var email = $('email').value.trim()
  var label = $('label').value.trim()
  if (!publisher) return showError('请填写发布者名')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(publisher) || publisher.length > 64) {
    return showError('发布者名只能含小写字母 / 数字 / 连字符，不能以连字符开头，最长 64 字符')
  }
  if (email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
    return showError('邮箱格式不正确')
  }
  var payload = { publisher: publisher }
  if (email) payload.email = email
  if (label) payload.label = label

  fetch('./api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function (res) {
    if (res.status === 201) return res.json().then(function (data) { onSuccess(data) })
    return res.text().then(function (text) { onFailure(res.status, text) })
  }, function () {
    onFailure(0, '网络错误，请稍后重试')
  })
})

function onSuccess(data) {
  form.hidden = true
  failureView.hidden = true
  $('token').value = data.token
  $('command').value =
    'npx uex login ' + data.publisher +
    ' --registry ' + location.origin + BASE.replace(/\\/$/, '') +
    ' --token ' + data.token
  resultView.hidden = false
}

function onFailure(status, message) {
  form.hidden = true
  $('failure-msg').textContent =
    '注册失败' + (status ? '（HTTP ' + status + '）' : '') + '：' + (message || '未知错误')
  failureView.hidden = false
}

$('copy-token').addEventListener('click', function () { copyText($('token').value, $('copy-tip')) })
$('copy-command').addEventListener('click', function () { copyText($('command').value, $('copy-tip')) })
$('retry').addEventListener('click', function () {
  failureView.hidden = true
  form.hidden = false
})
</script>
</body>
</html>
`
}
