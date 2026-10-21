// Files outside the allowed folders that the reel-media: protocol may still serve: the targets of
// symlinks the person put in their own Library. Registered when the app hands out a URL for one.
const listed = new Set<string>()

export function allowLinkedMedia(realPath: string): void {
  listed.add(realPath)
}

export function isLinkedMedia(realPath: string): boolean {
  return listed.has(realPath)
}
