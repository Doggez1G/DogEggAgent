// CSS Modules 类型声明——让 TypeScript 识别 *.module.css import 为对象。
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

// 纯 CSS import（无返回值）。
declare module '*.css'

// HTML 文件 import（Vite 入口）。
declare module '*.html'
