import { computed, ref } from 'vue'
import { setApiClientSurface, type ClientSurface } from '../api/client'

function detectInitialSurface(): ClientSurface {
  if (typeof window === 'undefined') return 'web'
  const params = new URLSearchParams(window.location.search)
  return params.get('client') === 'browser-extension' ? 'browser-extension' : 'web'
}

const surface = ref<ClientSurface>(detectInitialSurface())
setApiClientSurface(surface.value)

export function useClientSurface() {
  function setSurface(next: ClientSurface) {
    surface.value = next
    setApiClientSurface(next)
  }

  return {
    surface,
    isBrowserExtension: computed(() => surface.value === 'browser-extension'),
    setSurface,
  }
}
