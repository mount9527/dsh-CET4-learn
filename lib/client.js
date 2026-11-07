/**
 * dsh-cet4 —— 客户端：左侧栏图标 + 主面板。
 *
 * 面板本体是一个 iframe，指向宿主挂载的 /cet4/app/index.html。
 * 这样做的好处是页面完全独立（可单独用浏览器打开调试），
 * 插件层只负责"把它放进左侧栏"这一件事。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cet4',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-cet4'
    const FRAME_SRC = '/cet4/app/index.html'
    const TITLE = 'CET-4 训练台'
    const BG = '#f4f6fb'

    /** 左侧栏图标：一个"4"，一眼能认出来是四级。 */
    function Cet4Icon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'span',
        { 'data-dsh-plugin': PANEL_ID, 'data-dsh-part': 'sidebar-icon', style: { display: 'inline-flex' } },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          // 外框
          h('path', { d: 'M4.5 3.5h15a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z', opacity: 0.45 }),
          // 数字 4
          h('path', { d: 'M14.6 7.2 8.9 14.6h6.8' }),
          h('path', { d: 'M14.6 7.2v8.4' }),
        ),
      )
    }

    /**
     * 主面板：整个区域就是一块 iframe。
     * 先靠 flex 撑满；若外层没有确定高度，再用视口高度兜底。
     */
    function Cet4Panel() {
      const boxRef = React.useRef(null)
      const [fallbackHeight, setFallbackHeight] = React.useState(0)

      React.useLayoutEffect(() => {
        const el = boxRef.current
        if (!el) return

        let frame = 0
        const measure = () => {
          const rect = el.getBoundingClientRect()
          const iframe = el.firstElementChild
          const filled = iframe ? iframe.clientHeight : 0
          // flex 已经撑起来了就不要再插手
          if (filled > 200) {
            setFallbackHeight((prev) => (prev === 0 ? prev : 0))
            return
          }
          const available = Math.max(320, Math.floor(window.innerHeight - rect.top - 2))
          setFallbackHeight((prev) => (Math.abs(prev - available) > 2 ? available : prev))
        }
        const schedule = () => {
          if (frame) cancelAnimationFrame(frame)
          frame = requestAnimationFrame(measure)
        }

        schedule()
        const timers = [setTimeout(measure, 120), setTimeout(measure, 480)]
        window.addEventListener('resize', schedule)

        let observer = null
        if (typeof ResizeObserver !== 'undefined' && el.parentElement) {
          observer = new ResizeObserver(schedule)
          observer.observe(el.parentElement)
        }

        return () => {
          if (frame) cancelAnimationFrame(frame)
          timers.forEach(clearTimeout)
          window.removeEventListener('resize', schedule)
          if (observer) observer.disconnect()
        }
      }, [])

      return h(
        'div',
        {
          ref: boxRef,
          'data-dsh-plugin': PANEL_ID,
          'data-dsh-part': 'panel',
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: fallbackHeight ? `${fallbackHeight}px` : '100%',
            minHeight: 0,
            overflow: 'hidden',
            background: BG,
          },
        },
        h('iframe', {
          src: FRAME_SRC,
          title: TITLE,
          allow: 'clipboard-write',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            minHeight: 0,
            border: 0,
            display: 'block',
            background: BG,
          },
        }),
      )
    }

    /**
     * 把图标和面板同时挂上：两者必须在同一处注册，
     * 因为左侧栏的图标列表本身也是插槽（没有列表就没有图标位）。
     */
    function mount(ctx) {
      return ctx.slots.inject('main', () =>
        ctx.slots.inject('sidebar.panellist', () => {
          const disposers = []

          disposers.push(
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                label: () => TITLE,
              },
              Cet4Panel,
            ),
          )

          try {
            disposers.push(
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 42,
                  label: () => TITLE,
                },
                Cet4Icon,
              ),
            )
          } catch (error) {
            // 没有左侧栏列表位（例如老版本布局）时，至少别把面板也一起丢掉
            console.warn('[dsh-cet4] 左侧栏图标注册失败：', error)
          }

          return () => {
            while (disposers.length) {
              const off = disposers.pop()
              try {
                if (typeof off === 'function') off()
              } catch (error) {
                console.warn('[dsh-cet4] 卸载失败：', error)
              }
            }
          }
        }),
      )
    }

    function apply(ctx) {
      ctx.effect(() => mount(ctx), 'dsh-cet4: 左侧栏图标与主面板')
    }

    exports.name = PANEL_ID
    exports.inject = ['slots', 'layout']
    exports.apply = apply
    exports.Cet4Icon = Cet4Icon
    exports.Cet4Panel = Cet4Panel
    return module.exports
  },
})
