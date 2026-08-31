import type * as React from "react";

declare module "*.css";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
