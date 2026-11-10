#!/usr/bin/env bash
# 微信的"眼睛和手"：找主窗、截图、点、打字/按键、读无障碍树。
# 只做这几件事——不提供 shell，所以她能做微信里的动作，但拿不到这台机器。
set -u

export DISPLAY="${WX_DISPLAY:-:99}"
export WX_DISPLAY="$DISPLAY"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"
# 宿主是 systemd 服务时通常没有这两个变量；微信已经挂在用户总线上，
# 补默认值让无障碍树在任何宿主里都能连上（Desktop 只带了 DBUS，web 两个都没带）。
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/1000/bus}"
export AT_SPI_BUS_ADDRESS="${AT_SPI_BUS_ADDRESS:-unix:path=/run/user/1000/at-spi/bus}"

# 这个脚本可能通过符号链接被调用（工作台用 ~/dsh-plugins/dsh-wx）。Node 的 ESM
# 入口守卫比较的是 realpath，而 argv[1] 会保留符号链接路径，导致 ocr-snapshot.mjs /
# chats-json.mjs 加载后静默不执行（exit 0、无输出）。这里固定用 realpath。
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# 无障碍总线的 socket：以宿主给的 AT_SPI_BUS_ADDRESS 为准，没有就用 WSL 的默认路径。
bus_socket() {
  local a="${AT_SPI_BUS_ADDRESS:-}"
  case "$a" in
    unix:path=*) printf '%s' "${a#unix:path=}" ;;
    *) printf '%s' /run/user/1000/at-spi/bus ;;
  esac
}

# 微信 4.x 在无 GPU 的 Xvfb 上会多留一个渲染不出来的顶层窗（黑框）。
# 一律按面积取最大的那个当主窗，绝不用 head -1。
pick() {
  local best="" bestarea=0 id g area
  local X=0 Y=0 WIDTH=0 HEIGHT=0
  for id in $(xdotool search --name 'Weixin' 2>/dev/null); do
    g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
    eval "$g"
    area=$((WIDTH * HEIGHT))
    if [ "$area" -gt "$bestarea" ]; then
      bestarea=$area
      best="$id"
      PX=$X; PY=$Y; PW=$WIDTH; PH=$HEIGHT
    fi
  done
  [ -n "$best" ] || return 1
  echo "$best $PX $PY $PW $PH"
}

# 表情面板是独立的工具窗：WM_NAME 为空、WM_CLASS=wechat、类型 UTILITY。
# 不能按标题找；按 class + 空标题 + 类型 + 可见来认，尺寸只用于报告，
# 扫描器自己会拒绝非 485x485，这样尺寸异常时也能确认“面板确实开着”并关掉。
panel_find() {
  local id g name
  local X=0 Y=0 WIDTH=0 HEIGHT=0
  for id in $(xdotool search --class '^wechat$' 2>/dev/null); do
    name=$(xprop -id "$id" WM_NAME 2>/dev/null | sed -n 's/^[^=]*= //p')
    [ -z "$name" ] || continue
    case "$(xprop -id "$id" _NET_WM_WINDOW_TYPE 2>/dev/null)" in
      *UTILITY*) ;;
      *) continue ;;
    esac
    xwininfo -id "$id" 2>/dev/null | grep -q 'Map State: IsViewable' || continue
    g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
    eval "$g"
    echo "$id $X $Y $WIDTH $HEIGHT"
    return 0
  done
  return 1
}

# 右键菜单也是独立小窗：class=wechat、WM_NAME 空、类型不是 UTILITY（和表情面板区分开）。
# 只在“点了右键之后”用它；找不到就返回 1，不猜。
menu_find() {
  local id g name
  local X=0 Y=0 WIDTH=0 HEIGHT=0
  for id in $(xdotool search --class '^wechat$' 2>/dev/null); do
    name=$(xprop -id "$id" WM_NAME 2>/dev/null | sed -n 's/^[^=]*= //p')
    [ -z "$name" ] || continue
    xwininfo -id "$id" 2>/dev/null | grep -q 'Map State: IsViewable' || continue
    g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
    eval "$g"
    [ "$WIDTH" -ge 100 ] && [ "$HEIGHT" -ge 60 ] || continue
    [ "$((WIDTH * HEIGHT))" -lt 200000 ] || continue
    echo "$id $X $Y $WIDTH $HEIGHT"
    return 0
  done
  return 1
}

# 输入栏最左边的表情按钮：相对主窗 (347, 高度-33)。点它是开/关面板的可靠方式；
# Alt+E 只在面板关着时可靠，面板开着时不会收起。
emoji_button() {
  p=$(pick) || return 1
  set -- $p
  echo "$(( $2 + 347 )) $(( $3 + $5 - 33 ))"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  pick)
    p=$(pick) || { echo "找不到微信窗口（DISPLAY=$DISPLAY）" >&2; exit 2; }
    echo "$p"
    ;;

  shot)
    out="${1:?要输出路径}"
    mkdir -p "$(dirname "$out")"
    p=$(pick) || { echo "找不到微信窗口（DISPLAY=$DISPLAY）" >&2; exit 2; }
    set -- $p
    id=$1; w=$4; h=$5
    import -window "$id" -silent "$out" 2>/dev/null || {
      echo "截图失败（窗口 $id）" >&2; exit 3; }
    echo "$id $w $h"
    ;;

  click)
    x="${1:?要 x}"; y="${2:?要 y}"; btn="${3:-1}"
    p=$(pick) || { echo "找不到微信窗口" >&2; exit 2; }
    set -- $p
    id=$1; wx=$2; wy=$3
    # 坐标是屏幕绝对坐标（wx_peek 给的就是这个），不再加窗口原点
    xdotool windowfocus "$id" 2>/dev/null || true
    xdotool mousemove "$x" "$y" click "$btn"
    echo "点了 ($x,$y)"
    ;;

  type)
    text="${1:?要文本}"
    p=$(pick) >/dev/null 2>&1 || { echo "找不到微信窗口" >&2; exit 2; }
    xdotool type --clearmodifiers --delay 20 -- "$text"
    echo "打了 ${#text} 个字"
    ;;

  key)
    keys="${1:?要键名}"
    xdotool key --clearmodifiers "$keys"
    echo "按了 $keys"
    ;;

  peek)
    cd /home/str1k3/cu-test 2>/dev/null || { echo "没有 ~/cu-test" >&2; exit 2; }
    node peek-wx.mjs 2>&1 | head -c 200000
    ;;

  tree)
    cd /home/str1k3/cu-test 2>/dev/null || { echo "没有 ~/cu-test" >&2; exit 2; }
    node wx-elements.mjs 2>&1 | head -c 200000
    ;;

  ocr)
    node "$LIB_DIR/ocr-snapshot.mjs" 2>&1 | head -c 200000
    ;;

  speakers)
    # 这是给上层解析的接口，node 的失败码要跟着传出去；输出仍然限长。
    out=$(node "$LIB_DIR/ocr-speakers.mjs" 2>&1); status=$?
    printf '%s\n' "$out" | head -c 200000
    exit "$status"
    ;;

  chats)
    # 优先用无障碍树：它能给出当前会话名和完整会话列表；树不可用时再退回 OCR。
    # （OCR 只能按几何分组，未读红点行容易漏，且永远读不到当前会话。）
    # tree 的输出是给人看的文本，不是 JSON，先交给 chats-json 解析再判断是否可用。
    tree_out="$(bash "$0" tree 2>/dev/null || true)"
    tree_json="$(printf '%s' "$tree_out" | node "$LIB_DIR/chats-json.mjs" 2>/dev/null || true)"
    if printf '%s' "$tree_json" | node -e '
      let s = ""
      process.stdin.on("data", (d) => s += d).on("end", () => {
        try { const j = JSON.parse(s); process.exit(j.ok === true && Array.isArray(j.chats) && j.chats.length > 0 ? 0 : 1) }
        catch { process.exit(1) }
      })
    ' 2>/dev/null; then
      printf '%s\n' "$tree_json"
    else
      bash "$0" ocr | node "$LIB_DIR/chats-json.mjs"
    fi
    ;;

  pixhash)
    # 窗口截图里某块区域的像素摘要：拿来和无障碍树对账（树没变、屏幕变了 = 树落后）
    x="${1:?x}"; y="${2:?y}"; w="${3:?w}"; h="${4:?h}"
    p=$(pick) || { echo "找不到微信窗口" >&2; exit 2; }
    set -- $p
    import -window "$1" -silent png:- 2>/dev/null \
      | convert png:- -crop "${w}x${h}+${x}+${y}" +repage -depth 8 rgb:- 2>/dev/null \
      | md5sum | cut -c1-12
    ;;

  menu-find)
    menu_find || exit 1
    ;;

  menu-shot)
    # 右键菜单截图：输出 "<windowId> <x> <y> <w> <h>"，坐标是屏幕绝对坐标。
    out="${1:?要输出路径}"
    mkdir -p "$(dirname "$out")"
    p=$(menu_find) || { echo "没有找到右键菜单" >&2; exit 2; }
    set -- $p
    import -window "$1" -silent "$out" 2>/dev/null || { echo "菜单截图失败" >&2; exit 3; }
    echo "$p"
    ;;

  panel-find)
    panel_find || exit 1
    ;;

  panel-open)
    # 已开着就复用；没开就聚焦主窗按 Alt+E，等独立面板窗出现（最多 2 秒）。
    if p=$(panel_find); then echo "$p"; exit 0; fi
    p=$(pick) || { echo "找不到微信窗口" >&2; exit 2; }
    set -- $p
    xdotool windowfocus "$1" 2>/dev/null || true
    xdotool key --clearmodifiers alt+e
    i=0
    while [ "$i" -lt 8 ]; do
      sleep 0.3
      if p=$(panel_find); then echo "$p"; exit 0; fi
      i=$((i + 1))
    done
    echo "表情面板没有打开" >&2
    exit 3
    ;;

  panel-close)
    if ! p=$(panel_find); then echo "closed"; exit 0; fi
    # 点输入栏表情按钮切换关闭（Alt+E 只在打开时有效，不能当开关用）。
    b=$(emoji_button) || { echo "找不到微信窗口" >&2; exit 2; }
    set -- $b
    xdotool mousemove "$1" "$2" click 1
    sleep 0.5
    if panel_find >/dev/null; then echo "still-open"; exit 1; else echo "closed"; fi
    ;;

  panel-click)
    # 坐标相对面板左上角。扫描只点页签/安全空白；发送阶段由 sticker-send.js
    # 在重新截图确认 pHash 之后才点目标格，这里不替调用方做安全判断。
    x="${1:?要 x}"; y="${2:?要 y}"
    p=$(panel_find) || { echo "面板没开" >&2; exit 2; }
    set -- $p
    id=$1; ox=$2; oy=$3
    xdotool windowfocus "$id" 2>/dev/null || true
    xdotool mousemove "$((ox + x))" "$((oy + y))" click 1
    echo "点了面板内 ($x,$y)"
    ;;

  panel-scroll-up)
    # 在内容区中央向上滚，回到收藏页顶部；不点任何格子。
    times="${1:-10}"
    p=$(panel_find) || { echo "面板没开" >&2; exit 2; }
    set -- $p
    id=$1; ox=$2; oy=$3
    xdotool windowfocus "$id" 2>/dev/null || true
    xdotool mousemove "$((ox + 242))" "$((oy + 160))"
    i=0
    while [ "$i" -lt "$times" ]; do
      xdotool click 4 2>/dev/null
      sleep 0.03
      i=$((i + 1))
    done
    echo "面板已滚到顶"
    ;;

  panel-park)
    # 鼠标停到面板右下角的空白区（不在任何格子上），避免悬停放大/预览改变截图。
    p=$(panel_find) || { echo "面板没开" >&2; exit 2; }
    set -- $p
    id=$1; ox=$2; oy=$3
    xdotool windowfocus "$id" 2>/dev/null || true
    xdotool mousemove "$((ox + 460))" "$((oy + 400))"
    echo "鼠标已停到面板空白区"
    ;;

  panel-shot)
    out="${1:?要输出路径}"
    mkdir -p "$(dirname "$out")"
    p=$(panel_find) || { echo "面板没开" >&2; exit 2; }
    set -- $p
    import -window "$1" -silent "$out" 2>/dev/null || {
      echo "面板截图失败（窗口 $1）" >&2; exit 3; }
    echo "$p"
    ;;

  panel-gray)
    # 面板 PNG → 原始灰度字节 → base64（Node 侧不引 PNG 解码依赖）。
    png="${1:?要 PNG}"
    convert "$png" -colorspace Gray -depth 8 gray:- 2>/dev/null | base64 -w0
    ;;

  panel-thumb)
    # 从面板截图裁一格，缩到 128x128 落盘。
    png="${1:?要 PNG}"; x="${2:?x}"; y="${3:?y}"; w="${4:?w}"; h="${5:?h}"; out="${6:?out}"
    mkdir -p "$(dirname "$out")"
    convert "$png" -crop "${w}x${h}+${x}+${y}" +repage -resize 128x128 "$out" 2>/dev/null \
      || { echo "缩略图失败" >&2; exit 3; }
    echo "$out"
    ;;

  win-gray)
    # 主窗口内某块区域的灰度字节 → base64。坐标相对窗口左上角（不是屏幕坐标），
    # 用于发送回执时裁表情气泡；不落盘、不碰鼠标。
    x="${1:?x}"; y="${2:?y}"; w="${3:?w}"; h="${4:?h}"
    p=$(pick) || { echo "找不到微信窗口" >&2; exit 2; }
    set -- $p
    import -window "$1" -silent png:- 2>/dev/null \
      | convert png:- -crop "${w}x${h}+${x}+${y}" +repage -colorspace Gray -depth 8 gray:- 2>/dev/null \
      | base64 -w0
    ;;

  sha256)
    f="${1:?要文件}"
    sha256sum "$f" 2>/dev/null | cut -d' ' -f1
    ;;

  mouse)
    xdotool getmouselocation --shell 2>/dev/null | awk -F= '/^X=/{x=$2} /^Y=/{y=$2} END{print x","y}'
    ;;

  nudge)
    # 轻轻滚一下会话列表再滚回来，逼列表重发一遍无障碍事件。列表位置不变。
    x="${1:?x}"; y="${2:?y}"
    xdotool mousemove "$x" "$y" click 5 2>/dev/null
    sleep 0.15
    xdotool click 4 2>/dev/null
    echo "滚了一下 ($x,$y)"
    ;;

  scroll)
    # 只滚鼠标停的位置，不点开会话：目录扫描靠它翻侧栏。
    x="${1:?要 x}"; y="${2:?要 y}"; dir="${3:-down}"; times="${4:-5}"
    case "$dir" in
      up) btn=4 ;;
      down) btn=5 ;;
      *) echo "scroll: direction 只能是 up/down" >&2; exit 64 ;;
    esac
    p=$(pick) || { echo "找不到微信窗口" >&2; exit 2; }
    id=$(printf '%s' "$p" | awk '{print $1}')
    xdotool windowfocus "$id" 2>/dev/null || true
    xdotool mousemove "$x" "$y"
    i=0
    while [ "$i" -lt "$times" ]; do
      xdotool click "$btn" 2>/dev/null
      sleep 0.06
      i=$((i + 1))
    done
    echo "滚了 $dir x$times ($x,$y)"
    ;;

  clicklabel)
    want="${1:?要一个标签}"
    cd /home/str1k3/cu-test 2>/dev/null || { echo "没有 ~/cu-test" >&2; exit 2; }
    node wx-click-label.mjs "$want" 2>&1 | head -c 4000
    ;;

  atspi)
    # 只读：无障碍总线的 socket 在不在、用户服务状态。
    sock=$(bus_socket)
    if [ -S "$sock" ]; then s=present; else s=missing; fi
    state=$(systemctl --user is-active at-spi-dbus-bus.service 2>/dev/null || true)
    printf '{"socket":"%s","socketState":"%s","service":"%s"}\n' "$sock" "$s" "${state:-unknown}"
    [ "$s" = present ]
    ;;

  bus-start)
    # 初始化时用：Qt 的无障碍桥只在启动时连一次总线，所以总线必须先于微信存在。
    # 这里不碰微信，只把用户级 at-spi 总线拉起来并等 socket 出现（最多 10 秒）。
    sock=$(bus_socket)
    started=0
    if [ ! -S "$sock" ]; then
      systemctl --user start at-spi-dbus-bus.service >/dev/null 2>&1 && started=1
      i=0
      while [ "$i" -lt 50 ]; do
        [ -S "$sock" ] && break
        sleep 0.2
        i=$((i + 1))
      done
    fi
    state=$(systemctl --user is-active at-spi-dbus-bus.service 2>/dev/null || true)
    if [ -S "$sock" ]; then
      printf '{"ok":true,"socket":"%s","started":%s,"service":"%s"}\n' "$sock" "$started" "${state:-unknown}"
    else
      printf '{"ok":false,"socket":"%s","started":%s,"service":"%s"}\n' "$sock" "$started" "${state:-unknown}" >&2
      exit 4
    fi
    ;;

  pid)
    # 微信主进程 PID。MainPID 变了 = 微信被重启过；耳朵据此判断
    # 「重启后无障碍树没回来」（见 tree.js restartEpisode）。
    pid=$(systemctl show -p MainPID --value wechat-fish.service 2>/dev/null || true)
    case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
    printf '{"ok":true,"pid":%s,"unit":"wechat-fish.service"}\n' "$pid"
    ;;

  restart)
    # 只重启 wechat-fish.service 自己的主进程，靠 systemd Restart=always 拉回来。
    # 重启前核实：单元 active、MainPID 存在、comm 确实是微信；不满足就什么都不做。
    unit="wechat-fish.service"
    active=$(systemctl is-active "$unit" 2>/dev/null || true)
    if [ "$active" != active ]; then
      printf '{"ok":false,"error":"%s 不是 active（%s）"}\n' "$unit" "${active:-unknown}" >&2
      exit 5
    fi
    old=$(systemctl show -p MainPID --value "$unit" 2>/dev/null | tr -d ' ')
    if [ -z "$old" ] || [ "$old" = 0 ]; then
      echo '{"ok":false,"error":"拿不到 MainPID"}' >&2
      exit 5
    fi
    comm=$(cat "/proc/$old/comm" 2>/dev/null || true)
    case "$comm" in
      wechat|wechat*) ;;
      *) printf '{"ok":false,"error":"MainPID %s 不是微信（comm=%s）"}\n' "$old" "${comm:-?}" >&2; exit 5 ;;
    esac
    kill -TERM "$old" 2>/dev/null || {
      printf '{"ok":false,"error":"TERM %s 失败"}\n' "$old" >&2; exit 5; }
    pid=0; i=0
    while [ "$i" -lt 100 ]; do
      sleep 0.3
      pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null | tr -d ' ')
      if [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != "$old" ] &&
         [ "$(systemctl is-active "$unit" 2>/dev/null || true)" = active ]; then
        break
      fi
      i=$((i + 1))
    done
    if [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != "$old" ]; then
      printf '{"ok":true,"oldPid":%s,"pid":%s,"waitedMs":%s}\n' "$old" "$pid" "$((i * 300))"
    else
      printf '{"ok":false,"oldPid":%s,"error":"重启后没等到新的 MainPID"}\n' "$old" >&2
      exit 6
    fi
    ;;

  clean)
    # Qt 的浮层（右键菜单/消息工具条）会盖在主窗上面并吃掉点击：
    # 实测它们让「点谁都没反应」。这里只关小的浮层，主窗不碰。
    #
    # 还有一种大的：会话被「弹出」成独立窗口（623x666，以窗口名＝会话名）。
    # 这套 Xvfb 没有窗口管理器，弹出窗固定居中叠在主窗上，把左边会话列表整个盖住——
    # 之后点列表的坐标全落在弹出窗里（「读不到当前会话」），截图里主窗被盖住的那块是黑的。
    # 实测：聚焦后 ~120ms 内连点两下会话行就会弹出。这里点它自己的 ✕（和手点一样）关掉，
    # 关完会话回到主窗里，再 wx_click 会话名即可。
    # 主窗之外还叫 Weixin/wechat 的大窗是渲染黑框（2026-11-03 登录后出现过 583x458，
    # 正好盖住聊天区、吃掉点击）；直接 unmap，主窗按面积挑，不会被误伤。
    main=$(pick 2>/dev/null | awk '{print $1}')
    n=0; p=0
    for id in $( (xdotool search --class wechat 2>/dev/null; xdotool search --name '^wechat$' 2>/dev/null) | sort -u); do
      [ "$id" = "$main" ] && continue
      g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
      eval "$g"
      if [ "$((WIDTH * HEIGHT))" -ge 200000 ]; then
        nm=$(xdotool getwindowname "$id" 2>/dev/null)
        case "$nm" in
          ""|Weixin|wechat) xdotool windowunmap "$id" 2>/dev/null && n=$((n + 1)); continue ;;
        esac
        [ "$(xwininfo -id "$id" 2>/dev/null | awk '/Map State/{print $3}')" = "IsViewable" ] || continue
        xdotool mousemove "$((X + WIDTH - 25))" "$((Y + 17))" click 1 2>/dev/null && p=$((p + 1))
        sleep 0.6
        continue
      fi
      xdotool windowunmap "$id" 2>/dev/null && n=$((n + 1))
    done
    echo "关掉 $n 个浮层，$p 个弹出的会话窗"
    ;;

  *)
    echo "用法: wx.sh {pick|shot <out>|clean|click <x> <y> [btn]|clicklabel <标签>|type <text>|key <keys>|peek|tree|chats|ocr|speakers|pixhash <x> <y> <w> <h>|mouse|nudge <x> <y>|scroll <x> <y> <up|down> [times]|atspi|bus-start|pid|restart|panel-find|panel-open|panel-close|panel-click <x> <y>|panel-scroll-up [times]|panel-park|panel-shot <out>|panel-gray <png>|panel-thumb <png> <x> <y> <w> <h> <out>|win-gray <x> <y> <w> <h>|sha256 <file>}" >&2
    exit 64
    ;;
esac
