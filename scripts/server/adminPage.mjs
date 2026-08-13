/*---------------------------------------------------------------------------------------------
 *  审批管理页（GET <base>gallery/admin）：注册审批制的管理员操作界面。
 *  与 registerPage.mjs 同一形态：完整 HTML 以字符串内嵌，CSS/JS 全部内联、零外部资源——
 *  dist/server.js 是单文件部署形态，不能引入静态目录。
 *  主题与下载页（download-page/index.html）共用一套深色令牌，见 pageStyles.mjs。
 *
 *  安全约定：所有动态数据插入 DOM 一律走 textContent / input.value，绝不拼 innerHTML。
 *  管理令牌仅存 sessionStorage（关标签即清），页面内存使用；令牌正确性由管理 API 的
 *  401/503 回判（页面自身不做任何校验）。
 *--------------------------------------------------------------------------------------------*/

import { PAGE_BASE_CSS } from './pageStyles.mjs'

export function adminPageHtml(base) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>审批管理 · Universe 扩展市场</title>
<style>${PAGE_BASE_CSS}
  .card { max-width: 720px; margin-top: 24px; padding: 28px 32px 32px; }
  h2 { font-size: 15px; margin: 26px 0 8px; display: flex; align-items: center; gap: 8px; }
  .intro { font-size: 13px; line-height: 1.7; color: var(--muted); margin: 0 0 16px; }
  .badge {
    display: inline-block; min-width: 20px; padding: 1px 7px; border-radius: 10px;
    background: var(--danger); color: #fff; font-size: 12px; font-weight: 700; text-align: center;
  }
  .badge.zero { background: #6e7681; }
  .row {
    display: flex; align-items: center; gap: 12px; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: 8px; margin-top: 8px;
  }
  .row.pending { border-color: rgba(210, 153, 34, 0.5); background: rgba(210, 153, 34, 0.1); }
  .meta { flex: 1; min-width: 0; }
  .name { font-weight: 700; font-size: 14px; font-family: ui-monospace, Consolas, monospace; }
  .detail { font-size: 12px; color: var(--muted); margin-top: 2px; word-break: break-all; }
  .empty { font-size: 13px; color: var(--muted); margin-top: 8px; }
  .error { color: #ff7b72; font-size: 13px; margin: 12px 0 0; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
  #toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600;
    color: #fff; background: #238636; box-shadow: 0 2px 10px rgba(0,0,0,0.4); z-index: 10;
  }
  #toast.err { background: var(--danger); }
</style>
</head>
<body>
<div id="toast" hidden></div>
<main class="card">
  <a class="back" href="../">&larr; 返回下载页</a>
  <section id="login-view">
    <h1>审批管理</h1>
    <p class="intro">
      输入管理令牌进入审批台（令牌由运维通过 <code>--admin-token-file</code> 配置）。
      令牌只保存在本标签页的 sessionStorage，关闭即清除。
    </p>
    <input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="管理令牌">
    <p id="login-error" class="error" hidden></p>
    <div class="toolbar">
      <button id="login-btn" type="button">进入</button>
    </div>
  </section>

  <section id="main-view" hidden>
    <h1>审批管理</h1>
    <div class="toolbar">
      <button id="refresh-btn" type="button" class="ghost">刷新</button>
      <button id="logout-btn" type="button" class="ghost">退出（清除令牌）</button>
    </div>

    <h2>待审批 <span id="pending-badge" class="badge zero">0</span></h2>
    <div id="pending-list"></div>

    <h2>已启用</h2>
    <div id="active-list"></div>

    <h2>已拒绝</h2>
    <div id="rejected-list"></div>
  </section>
</main>
<script>
'use strict'
var BASE = ${JSON.stringify(base)}
var $ = function (id) { return document.getElementById(id) }
var loginView = $('login-view')
var mainView = $('main-view')
var toast = $('toast')
var toastTimer = null

function showToast(msg, isErr) {
  toast.textContent = msg
  toast.className = isErr ? 'err' : ''
  toast.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(function () { toast.hidden = true }, 3000)
}

function currentToken() {
  return sessionStorage.getItem('ue-admin-token') || ''
}

// 401/503 在此处已给出准确提示，抛出带 handled 标记的错误，
// 外层 catch 据此跳过兜底的「网络错误」提示，避免覆盖。
function handledError(msg) {
  var err = new Error(msg)
  err.handled = true
  return err
}

function api(path, method, body) {
  return fetch('./api/admin/' + path, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + currentToken(),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(function (res) {
    if (res.status === 401) {
      showLogin('令牌错误或已失效，请重新输入')
      throw handledError('unauthorized')
    }
    if (res.status === 503) {
      showLogin('服务端未启用管理台（admin console disabled），请联系运维配置 --admin-token-file')
      throw handledError('disabled')
    }
    return res.text().then(function (text) { return { status: res.status, text: text } })
  })
}

function unlessHandled(fn) {
  return function (err) {
    if (!err || !err.handled) fn()
  }
}

function showLogin(errMsg) {
  mainView.hidden = true
  loginView.hidden = false
  var el = $('login-error')
  el.textContent = errMsg || ''
  el.hidden = !errMsg
}

function showMain() {
  loginView.hidden = true
  mainView.hidden = false
}

function fmtTime(iso) {
  if (!iso) return '时间未知'
  var d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function detailText(p) {
  var parts = []
  parts.push(p.email || '无邮箱')
  parts.push(fmtTime(p.created))
  parts.push('token ' + p.tokenCount + ' 个')
  parts.push('扩展 ' + (p.extensions ? p.extensions.length : 0) + ' 个')
  if (p.extensions && p.extensions.length) parts.push(p.extensions.join('、'))
  return parts.join(' · ')
}

function actionButton(label, cls, onClick) {
  var btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  if (cls) btn.className = cls
  btn.addEventListener('click', function () {
    btn.disabled = true
    var done = function () { btn.disabled = false }
    Promise.resolve()
      .then(onClick)
      .then(done, done)
  })
  return btn
}

function buildRow(p) {
  var row = document.createElement('div')
  row.className = 'row' + (p.status === 'pending' ? ' pending' : '')
  var meta = document.createElement('div')
  meta.className = 'meta'
  var name = document.createElement('div')
  name.className = 'name'
  name.textContent = p.name
  var detail = document.createElement('div')
  detail.className = 'detail'
  detail.textContent = detailText(p)
  meta.appendChild(name)
  meta.appendChild(detail)
  row.appendChild(meta)

  if (p.status === 'pending') {
    row.appendChild(actionButton('批准', '', function () {
      return api('publishers/approve', 'POST', { name: p.name }).then(function (r) {
        if (r.status === 200) {
          showToast('已批准 ' + p.name)
          loadList()
        } else {
          showToast('批准失败（HTTP ' + r.status + '）：' + r.text, true)
        }
      })
    }))
    row.appendChild(actionButton('拒绝', 'danger', function () {
      if (!window.confirm('确认拒绝 ' + p.name + ' 的注册申请？其 token 将立即失效。')) return
      return api('publishers/reject', 'POST', { name: p.name }).then(function (r) {
        if (r.status === 200) {
          showToast('已拒绝 ' + p.name)
          loadList()
        } else {
          showToast('拒绝失败（HTTP ' + r.status + '）：' + r.text, true)
        }
      })
    }))
  } else if (p.status === 'rejected') {
    row.appendChild(actionButton('删除记录', 'danger', function () {
      if (!window.confirm('确认删除 ' + p.name + ' 的记录？删除后该名字可被重新注册。')) return
      return api('publishers/remove', 'POST', { name: p.name }).then(function (r) {
        if (r.status === 200) {
          showToast('已删除 ' + p.name + '，名字已释放')
          loadList()
        } else {
          showToast('删除失败（HTTP ' + r.status + '）：' + r.text, true)
        }
      })
    }))
  }
  return row
}

function renderSection(listEl, items, emptyText) {
  listEl.textContent = ''
  if (!items.length) {
    var empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = emptyText
    listEl.appendChild(empty)
    return
  }
  for (var i = 0; i < items.length; i++) listEl.appendChild(buildRow(items[i]))
}

function loadList() {
  return api('publishers', 'GET').then(function (r) {
    if (r.status !== 200) {
      showToast('拉取列表失败（HTTP ' + r.status + '）：' + r.text, true)
      return
    }
    var data = JSON.parse(r.text)
    var all = data.publishers || []
    var pending = []
    var active = []
    var rejected = []
    for (var i = 0; i < all.length; i++) {
      var p = all[i]
      if (p.status === 'pending') pending.push(p)
      else if (p.status === 'rejected') rejected.push(p)
      else active.push(p)
    }
    var badge = $('pending-badge')
    badge.textContent = String(pending.length)
    badge.className = 'badge' + (pending.length ? '' : ' zero')
    renderSection($('pending-list'), pending, '暂无待审批申请')
    renderSection($('active-list'), active, '暂无已启用的发布者')
    renderSection($('rejected-list'), rejected, '暂无已拒绝的记录')
    showMain()
  })
}

$('login-btn').addEventListener('click', function () {
  var token = $('token-input').value.trim()
  if (!token) {
    showLogin('请输入管理令牌')
    return
  }
  sessionStorage.setItem('ue-admin-token', token)
  showLogin('')
  loadList().catch(unlessHandled(function () { showLogin('网络错误，请稍后重试') }))
})
$('token-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') $('login-btn').click()
})
$('refresh-btn').addEventListener('click', function () {
  loadList().catch(unlessHandled(function () { showToast('网络错误，请稍后重试', true) }))
})
$('logout-btn').addEventListener('click', function () {
  sessionStorage.removeItem('ue-admin-token')
  $('token-input').value = ''
  showLogin('')
})

if (currentToken()) {
  loadList().catch(unlessHandled(function () { showLogin('网络错误，请稍后重试') }))
} else {
  showLogin('')
}
</script>
</body>
</html>
`
}
