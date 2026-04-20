import { Component, type ErrorInfo, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import i18n from "@/i18n"

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: "" }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-10 text-center">
          <h1 className="text-lg font-semibold text-destructive">{i18n.t("errorBoundary.title")}</h1>
          <code className="max-w-lg rounded-md border bg-muted px-3 py-2 text-left text-sm text-foreground">
            {this.state.error}
          </code>
          <Button type="button" onClick={() => window.location.reload()}>
            {i18n.t("errorBoundary.reload")}
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
