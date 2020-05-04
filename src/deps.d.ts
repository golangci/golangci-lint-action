declare module "setup-go/lib/main" {
  function run(): Promise<void>
}

declare module "cache/lib/restore" {
  function run(): Promise<void>
  export default run
}

declare module "cache/lib/save" {
  function run(): Promise<void>
  export default run
}
