declare module "*.md" {
  const content: string;
  export default content;
}

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch(
      request: Request,
      server: {
        requestIP(request: Request): { address: string } | null;
      }
    ): Response | Promise<Response>;
  }): {
    hostname: string;
    port: number;
    stop(closeActiveConnections?: boolean): Promise<void>;
  };
};
