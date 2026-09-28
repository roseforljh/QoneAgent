import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JSXRuntime from "react/jsx-runtime";

declare global {
  interface Window {
    __qonePreview: { mount: (code: string) => void };
  }
}

const modules: Record<string, unknown> = {
  react: { ...React, default: React },
  "react-dom": { ...ReactDOM, default: ReactDOM },
  "react-dom/client": { ...ReactDOMClient, default: ReactDOMClient },
  "react/jsx-runtime": JSXRuntime,
};

class PreviewErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  render() {
    if (this.state.error) {
      return React.createElement("pre", { style: { color: "#b91c1c", whiteSpace: "pre-wrap" } }, this.state.error);
    }
    return this.props.children;
  }
}

window.__qonePreview = {
  mount(code) {
    const module = { exports: {} as { default?: unknown } };
    const requireModule = (name: string) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`Cannot preview dependency: ${name}`);
    };
    new Function("module", "exports", "require", "React", code)(module, module.exports, requireModule, React);
    const named = Object.entries(module.exports).filter(([name]) => name !== "__esModule");
    const component = module.exports.default ?? (named.length === 1 ? named[0]![1] : undefined);
    if (!component) throw new Error("Preview requires one exported React component.");
    const element = React.isValidElement(component) ? component : React.createElement(component as React.ElementType);
    ReactDOMClient.createRoot(document.getElementById("preview-root")!).render(
      React.createElement(PreviewErrorBoundary, null, element),
    );
  },
};
