#!/usr/bin/env bash
# 微信的"眼睛和手"：找主窗、截图、点、打字/按键、读无障碍树。
# 只做这几件事——不提供 shell，所以她能做微信里的动作，但拿不到这台机器。
set -u

export DISPLAY="${WX_DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"

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

  chats)
    # 会话列表的结构化 JSON（工作台的候选名单用）
    bash "$0" tree | node "$(dirname "$0")/chats-json.mjs"
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

  clicklabel)
    want="${1:?要一个标签}"
    cd /home/str1k3/cu-test 2>/dev/null || { echo "没有 ~/cu-test" >&2; exit 2; }
    node wx-click-label.mjs "$want" 2>&1 | head -c 4000
    ;;

  clean)
    # Qt 的浮层（右键菜单/消息工具条）会盖在主窗上面并吃掉点击：
    # 实测它们让「点谁都没反应」。这里只关小的浮层，主窗不碰。
    #
    # 还有一种大的：会话被「弹出」成独立窗口（623x666，以窗口名＝会话名）。
    # 这套 Xvfb 没有窗口管理器，弹出窗固定居中叠在主窗上，把左边会话列表整个盖住——
    # 之后点列表的坐标全落在弹出窗里（「读不到当前会话」），截图里主窗被盖住的那块是黑的。
    # 实测：聚焦后 ~120ms 内连点两下会话行就会弹出。这里点它自己的 ✕（和手点一样）关掉，
    # 关完会话回到主窗里，再 wx_click 会话名即可。名字叫 Weixin/wechat 的大窗是主窗或黑框，不碰。
    main=$(pick 2>/dev/null | awk '{print $1}')
    n=0; p=0
    for id in $( (xdotool search --class wechat 2>/dev/null; xdotool search --name '^wechat$' 2>/dev/null) | sort -u); do
      [ "$id" = "$main" ] && continue
      g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
      eval "$g"
      if [ "$((WIDTH * HEIGHT))" -ge 200000 ]; then
        nm=$(xdotool getwindowname "$id" 2>/dev/null)
        case "$nm" in ""|Weixin|wechat) continue ;; esac
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
    echo "用法: wx.sh {pick|shot <out>|clean|click <x> <y> [btn]|clicklabel <标签>|type <text>|key <keys>|peek|tree|chats|pixhash <x> <y> <w> <h>|mouse|nudge <x> <y>}" >&2
    exit 64
    ;;
esac
