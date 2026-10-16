/** Downloads a URL (a data: or blob: URL) as a file with the given name. */
export function downloadUrl(url: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Downloads text as a file. */
export function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  downloadUrl(url, fileName)
  // The download has started from the click; a later revoke leaves time for slow browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

let input: HTMLInputElement | null = null

/**
 * Lets the user pick one file through an <input type="file">; null when they cancel. One hidden
 * input stays in the page, since some mobile browsers drop the change event of a detached one.
 */
export function chooseFile(accept: string): Promise<File | null> {
  if (!input) {
    input = document.createElement('input')
    input.type = 'file'
    input.hidden = true
    document.body.appendChild(input)
  }
  const picker = input
  picker.accept = accept
  // Choosing the same file twice in a row still fires change.
  picker.value = ''
  return new Promise((resolve) => {
    picker.onchange = () => resolve(picker.files?.[0] ?? null)
    picker.oncancel = () => resolve(null)
    picker.click()
  })
}
