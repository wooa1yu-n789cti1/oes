import type { MeilongRoutePresentation } from '../types/site-route-policy'
import { onNuxtReady, useHead, useNuxtApp, useState } from '#app'
import { computed, type ComputedRef } from 'vue'

type SiteRoutePresentation = Extract<MeilongRoutePresentation, { action: 'render' }>

type SiteRouteHeadOwnerState = {
  ownerInstalled: boolean
  clientReady: boolean
  pendingPresentation: SiteRoutePresentation | null | undefined
  latestExposureSequence: number
}

const routeHeadOwners = new WeakMap<object, SiteRouteHeadOwnerState>()

// useSiteRouteExposure shares the single committed route presentation produced by global governance middleware.
export function useSiteRouteExposure() {
  return useState<SiteRoutePresentation | null>(
    'meilong-site-route-exposure',
    () => null
  )
}

// beginSiteRouteExposure reserves monotonic ownership so an older decision cannot overwrite a newer navigation.
export function beginSiteRouteExposure(): number {
  const ownerState = getSiteRouteHeadOwnerState(useNuxtApp())
  ownerState.latestExposureSequence += 1
  return ownerState.latestExposureSequence
}

// commitSiteRouteExposure immediately commits ready routes or stages only the latest pre-ready presentation.
export function commitSiteRouteExposure(
  presentation: SiteRoutePresentation | null,
  exposureSequence: number
): void {
  const nuxtApp = useNuxtApp()
  const exposure = useSiteRouteExposure()
  const ownerState = getSiteRouteHeadOwnerState(nuxtApp)
  if (exposureSequence !== ownerState.latestExposureSequence) {
    return
  }
  if (import.meta.server || ownerState.clientReady) {
    ownerState.pendingPresentation = undefined
    exposure.value = presentation
    return
  }
  ownerState.pendingPresentation = presentation
}

// useSiteRouteHead installs one declarative owner and flushes the latest staged route through Nuxt's public ready barrier.
export function useSiteRouteHead(): void {
  const nuxtApp = useNuxtApp()
  const ownerState = getSiteRouteHeadOwnerState(nuxtApp)
  if (ownerState.ownerInstalled) {
    return
  }
  ownerState.ownerInstalled = true
  const exposure = useSiteRouteExposure()
  if (import.meta.client) {
    onNuxtReady(() => {
      ownerState.clientReady = true
      const pendingPresentation = ownerState.pendingPresentation
      ownerState.pendingPresentation = undefined
      if (pendingPresentation !== undefined) {
        exposure.value = pendingPresentation
      }
    })
  }
  useHead(() => buildSiteRouteHead(exposure.value))
}

// getSiteRouteHeadOwnerState isolates declarative owner and ready-queue state per Nuxt application.
function getSiteRouteHeadOwnerState(nuxtApp: object): SiteRouteHeadOwnerState {
  const existing = routeHeadOwners.get(nuxtApp)
  if (existing) {
    return existing
  }
  const state: SiteRouteHeadOwnerState = {
    ownerInstalled: false,
    clientReady: import.meta.server,
    pendingPresentation: undefined,
    latestExposureSequence: 0
  }
  routeHeadOwners.set(nuxtApp, state)
  return state
}

// buildSiteRouteHead maps one committed presentation into the complete route-governance head entry.
function buildSiteRouteHead(presentation: SiteRoutePresentation | null) {
  return {
    htmlAttrs: presentation ? { lang: presentation.locale } : {},
    link: presentation
      ? [
          { key: 'site-canonical', rel: 'canonical' as const, href: presentation.canonicalUrl },
          ...presentation.hreflang.map((alternate) => ({
            key: `site-hreflang-${alternate.locale}`,
            rel: 'alternate' as const,
            type: 'text/html' as const,
            hreflang: alternate.locale,
            href: alternate.href
          }))
        ]
      : [],
    meta: presentation
      ? [{ key: 'site-robots', name: 'robots', content: presentation.robots }]
      : []
  }
}

// useSiteRouteCanonical returns the policy-owned canonical URL for structured data and social metadata helpers.
export function useSiteRouteCanonical(): ComputedRef<string | undefined> {
  const exposure = useSiteRouteExposure()
  return computed(() => exposure.value?.canonicalUrl)
}
