import type { JSX as ReactJSX } from 'react'
import type { LogicReaderApi } from '@logicreader/shared'

/**
 * React 19 起 JSX 命名空间不再全局暴露；这里做一次兼容声明，
 * 让 `JSX.Element` 这类写法在整个渲染进程继续可用。
 */
declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }

  interface Window {
    logicreader: LogicReaderApi
  }
}

export {}
