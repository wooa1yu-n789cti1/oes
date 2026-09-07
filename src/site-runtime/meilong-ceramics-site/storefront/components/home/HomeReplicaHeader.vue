<script setup lang="ts">
import {
  INSPIRATION_FILTER_INVENTORY as inspirationCategories
} from '~/data/inspiration-category-inventory'

type RootKey = 'products' | 'inspiration'
type MobileMode = 'root' | 'child' | 'subchild'

interface NavSection {
  title: string
  href: string
  links: Array<{ label: string; href: string }>
}

interface NavCard {
  title: string
  href: string
  image?: string
  description: string
}

interface NavTab {
  id: string
  label: string
  href: string
  centerColumns?: 1 | 2 | 3 | 5
  flow?: boolean
  title?: string
  logo?: boolean
  description?: string
  cta?: Array<{ label: string; href: string }>
  image?: string
  pattern?: boolean
  direct?: boolean
  sections: NavSection[]
  cards?: NavCard[]
}

const isMenuOpen = ref(false)
const isSearchOpen = ref(false)
const searchTerm = ref('')
const activeRoot = ref<RootKey>('products')
const activeDesktopTabId = ref('maidstone-dxv')
const isMegaContentOpen = ref(false)
const activeMobileRoot = ref<RootKey>('products')
const mobileMode = ref<MobileMode>('root')
const activeMobileTabId = ref('maidstone-dxv')
const activeMobileSectionIndex = ref(0)
const mobileSkippedChild = ref(false)
const mobileMenuTransitionName = ref('dxv-mobile-menu-forward')
const { openGuestCommerceDrawer, favoriteCount, cartItemCount } = useGuestCommerce()
const { openAccountDialog } = useAccountDialog()

const logoSrc = 'https://maidstonedxv.com/cdn/shop/files/logo.svg?v=1769442310'
const utilityLinks = [
  { label: 'About Us', href: '/about' },
  { label: 'Contact Us', href: '/contact' },
  { label: 'My Account', href: '#' }
]
const mobileUtilityLinks = [
  { label: 'My Account', href: '#' },
  { label: 'Partner Resources', href: '#' },
  { label: 'Contact Us', href: '/contact' },
  { label: 'About Us', href: '/about' }
]
const searchImage = {
  desktop: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-search-promo-desktop.jpg?v=1772570421&width=900',
  alt: 'Modern bathroom with freestanding bathtub, mirror, and decorative elements.',
}

const productTabs: NavTab[] = [
  {
    id: 'maidstone-dxv',
    label: 'MAIDSTONE | DXV',
    href: '/collections/maidstone-dxv',
    centerColumns: 2,
    logo: true,
    pattern: true,
    description:
      'Explore luxury bathtubs, sinks, vanities, and shower fixtures by MAIDSTONE | DXV crafted from premium materials with timeless design and elevated performance.',
    cta: [
      { label: 'New Arrivals', href: '/collections/maidstone-dxv-new-arrivals' },
      { label: 'View All MAIDSTONE | DXV', href: '/collections/maidstone-dxv' },
    ],
    image: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-maidstonedxv-desktop.jpg?format=webp&v=1773425157&width=800',
    sections: [
      {
        title: 'Bathtubs',
        href: '/collections/maidstone-dxv-bathtubs',
        links: ['Freestanding Bathtubs', 'Cast Iron Bathtubs', 'MINERALCAST Bathtubs', 'Solid Surface Bathtubs', 'Copper Bathtubs', 'Fluted Bathtubs'].map((label) => ({
          label,
          href: '#',
        })),
      },
      {
        title: 'Shower Bases',
        href: '/collections/maidstone-dxv-shower-bases',
        links: [{ label: 'Shower Bases', href: '#' }],
      },
      {
        title: 'Specialty Tubs',
        href: '/collections/maidstone-dxv-specialty-tubs',
        links: ['Carbon Fiber Bathtubs', 'Marble Bathtubs'].map((label) => ({ label, href: '#' })),
      },
    ],
  },
  {
    id: 'bathtubs',
    label: 'Bathtubs',
    href: '/collections/bathroom-bathtubs',
    centerColumns: 1,
    title: 'Bathtubs',
    description:
      'Explore luxury bathtubs in cast iron, copper, solid surface with freestanding, drop-in, and deep soaking styles for refined bathrooms.',
    cta: [
      { label: 'New Arrivals', href: '/collections/bathroom-bathtubs-new-arrivals' },
      { label: 'View All Bathtubs', href: '/collections/bathroom-bathtubs' },
    ],
    image: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-bathtubs-desktop.jpg?format=webp&v=1773425204&width=800',
    sections: [
      {
        title: 'Bathtubs',
        href: '/collections/bathroom-bathtubs',
        links: [
          'Freestanding Bathtubs',
          'Contemporary Bathtubs',
          'Drop-in Bathtubs',
          'Japanese Soaking Bathtubs',
          'Solid Surface Bathtubs',
          'Transparent Bathtubs',
          'Clawfoot Bathtubs',
          'Alcove Bathtubs',
          'Cast Iron Bathtubs',
          'Acrylic Bathtubs',
          'Hydrotherapy Bathtubs',
        ].map((label) => ({ label, href: '#' })),
      },
    ],
  },
  {
    id: 'vanities',
    label: 'Vanities',
    href: '/collections/bathroom-vanities',
    centerColumns: 1,
    title: 'Vanities',
    description:
      'Shop luxury bathroom vanities in single and double sink configurations with freestanding, floating, and console styles crafted from premium materials.',
    cta: [
      { label: 'New Arrivals', href: '/collections/bathroom-vanities-new-arrivals' },
      { label: 'View All Vanities', href: '/collections/bathroom-vanities' },
    ],
    image: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-vanities-desktop.jpg?format=webp&v=1773425239&width=800',
    sections: [
      {
        title: 'Vanities',
        href: '/collections/bathroom-vanities',
        links: ['Double Sink Vanities', 'Single Sink Vanities', 'Console Sink Vanities', 'Floating Sink Vanities'].map((label) => ({
          label,
          href: '#',
        })),
      },
    ],
  },
  {
    id: 'bathroom',
    label: 'Bathroom',
    href: '/collections/bathroom',
    centerColumns: 5,
    flow: true,
    sections: [
      {
        title: 'Bathtubs',
        href: '/collections/bathroom-bathtubs',
        links: [
          { label: 'Freestanding Bathtubs', href: '/collections/bathroom-bathtubs-freestanding' },
          { label: 'Contemporary Bathtubs', href: '/collections/bathroom-bathtubs-contemporary' },
          { label: 'Drop-In Bathtubs', href: '/collections/bathroom-bathtubs-drop-in' },
          { label: 'Japanese Soaking Bathtubs', href: '/collections/bathroom-bathtubs-japanese-soaking' },
          { label: 'Solid Surface Bathtubs', href: '/collections/bathroom-bathtubs-solid-surface' },
          { label: 'Transparent Bathtubs', href: '/collections/bathroom-bathtubs-transparent' },
          { label: 'Clawfoot Bathtubs', href: '/collections/bathroom-bathtubs-clawfoot' },
          { label: 'Alcove Bathtubs', href: '/collections/bathroom-bathtubs-alcove' },
          { label: 'Cast Iron Bathtubs', href: '/collections/bathroom-bathtubs-cast-iron' },
          { label: 'Acrylic Bathtubs', href: '/collections/bathroom-bathtubs-acrylic' },
          { label: 'Hydrotherapy Bathtubs', href: '/collections/bathroom-bathtubs-hydrotherapy' },
        ],
      },
      {
        title: 'Bathtub Faucets',
        href: '/collections/bathroom-bathtub-faucets',
        links: [
          { label: 'Freestanding Bathtub Faucets', href: '/collections/bathroom-bathtub-faucets-freestanding' },
          { label: 'Infinity Freestanding Bathtub Faucets', href: '/collections/bathroom-bathtub-faucets-high-flow' },
          { label: 'Deck Mount Bathtub Faucets', href: '/collections/bathroom-bathtub-faucets-deck-mount' },
          { label: 'Wall Mount Bathtub Faucets', href: '/collections/bathroom-bathtub-faucets-wall-mount' },
        ],
      },
      {
        title: 'Bathroom Sinks',
        href: '/collections/bathroom-sinks',
        links: [
          { label: 'Pedestal Sinks', href: '/collections/bathroom-sinks-pedestal' },
          { label: 'Console Sinks', href: '/collections/bathroom-sinks-console' },
          { label: 'Vessel Sinks', href: '/collections/bathroom-sinks-vessel' },
        ],
      },
      {
        title: 'Vanities',
        href: '/collections/bathroom-vanities',
        links: [
          { label: 'Double Sink Vanities', href: '/collections/bathroom-vanities-double-sink' },
          { label: 'Single Sink Vanities', href: '/collections/bathroom-vanities-single-sink' },
          { label: 'Console Sink Vanities', href: '/collections/bathroom-vanities-console-sink' },
          { label: 'Floating Sink Vanities', href: '/collections/bathroom-vanities-floating-sink' },
        ],
      },
      {
        title: 'Bathroom Sink Faucets',
        href: '/collections/bathroom-sink-faucets',
        links: [
          { label: 'Widespread Faucets', href: '/collections/bathroom-sink-faucets-widespread' },
          { label: 'Centerset Faucets', href: '/collections/bathroom-sink-faucets-centerset' },
          { label: 'Bridge Faucets', href: '/collections/bathroom-sink-faucets-bridge' },
          { label: 'Single Post Faucets', href: '/collections/bathroom-sink-faucets-single-post' },
        ],
      },
      {
        title: 'Showers',
        href: '/collections/bathroom-showers',
        links: [
          { label: 'Shower Kits', href: '/collections/bathroom-showers-shower-kits' },
          { label: 'Exposed Shower Sets', href: '/collections/bathroom-showers-exposed-shower-sets' },
          { label: 'Wall Mount Shower Systems', href: '/collections/bathroom-showers-wall-mount-shower-systems' },
          { label: 'Showerheads', href: '/collections/bathroom-showers-showerheads' },
          { label: 'Shower Bases', href: '/collections/bathroom-showers-shower-bases' },
          { label: 'Shower Parts', href: '/collections/bathroom-showers-shower-parts' },
          { label: 'Shower Drains', href: '/collections/bathroom-showers-shower-drains' },
        ],
      },
      {
        title: 'Bathroom Accessories',
        href: '/collections/bathroom-accessories',
        links: [
          { label: 'Drains and Supply Lines', href: '/collections/bathroom-accessories-drains-supply-lines' },
          { label: 'Bathtub Overflow Covers', href: '/collections/bathroom-accessories-bathtub-overflow' },
          { label: 'Shower Curtains & Rods', href: '/collections/bathroom-accessories-shower-curtains-rods' },
          { label: 'Bathtub Caddies & Trays', href: '/collections/bathroom-accessories-bathtub-caddies' },
          { label: 'Clawfoot Bathtub Coasters', href: '/collections/bathroom-accessories-clawfoot-coasters' },
          { label: 'Mirrors & Medicine Cabinets', href: '/collections/bathroom-accessories-mirrors-cabinets' },
        ],
      },
      {
        title: 'ADA Compliant',
        href: '/collections/bathroom-ada-compliant',
        links: [{ label: 'Walk In Bathtubs', href: '/collections/bathroom-ada-compliant-walk-in-bathtubs' }],
      },
      {
        title: 'Toilets & Seats',
        href: '/collections/bathroom-toilets-seats',
        links: [
          { label: 'One-Piece Toilets', href: '/collections/bathroom-toilets-seats-one-piece' },
          { label: 'Two-Piece Toilets', href: '/collections/bathroom-toilets-seats-two-piece' },
          { label: 'Toilet Seats', href: '/collections/bathroom-toilets-seats-toilet-seats' },
          { label: 'Bidets', href: '/collections/bathroom-toilets-seats-bidets' },
        ],
      },
      {
        title: 'Massachusetts Approved',
        href: '/collections/massachusetts-approved',
        links: [],
      },
    ],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    href: '/collections/kitchen',
    centerColumns: 2,
    title: 'Kitchen',
    description:
      'Shop kitchen sinks, kitchen faucets, bridge faucets, wall mount styles, and plumbing fixtures crafted from durable materials with long-lasting performance.',
    cta: [
      { label: 'New Arrivals', href: '/collections/kitchen-new-arrivals' },
      { label: 'View All Kitchen', href: '/collections/kitchen' },
    ],
    image: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-kitchen-desktop.jpg?format=webp&v=1773425264&width=800',
    sections: [
      {
        title: 'Kitchen Sink Faucets',
        href: '/collections/kitchen-sink-faucets',
        links: [
          { label: 'Bridge Faucets', href: '/collections/kitchen-sink-faucets-bridge' },
          { label: 'Wall Mount Faucets', href: '/collections/kitchen-sink-faucets-wall-mount' },
          { label: 'Single Post Faucets', href: '/collections/kitchen-sink-faucets-single-post' },
        ],
      },
      {
        title: 'Kitchen Sinks',
        href: '/collections/kitchen-sinks',
        links: [
          { label: 'Fireclay Kitchen Sinks', href: '/collections/kitchen-sinks-fireclay' },
          { label: 'Copper Kitchen Sinks', href: '/collections/kitchen-sinks-copper' },
          { label: 'Cast Iron Kitchen Sinks', href: '/collections/kitchen-sinks-cast-iron' },
        ],
      },
    ],
  },
  {
    id: 'wellness',
    label: 'Wellness',
    href: '/collections/wellness',
    centerColumns: 1,
    title: 'Wellness',
    description:
      'Explore wellness bathtubs including plunge tubs, deep soaking tubs, and hydrotherapy systems designed to promote relaxation, muscle recovery, and spa experiences.',
    cta: [{ label: 'View All Wellness', href: '/collections/wellness' }],
    image: 'https://cdn.shopify.com/s/files/1/0743/1713/6062/files/navigation-wellness-desktop.jpg?format=webp&v=1773425309&width=800',
    sections: [
      {
        title: 'Wellness',
        href: '/collections/wellness',
        links: [
          { label: 'Plunge Bathtubs', href: '/collections/wellness-plunge-bathtubs' },
          { label: 'Soaking Bathtubs', href: '/collections/wellness-soaking-bathtubs' },
        ],
      },
    ],
  },
]

// inspirationTabs mirrors the shared category provider so every valid category appears in both navigation surfaces.
const inspirationTabs: NavTab[] = inspirationCategories.map((category) => ({
  id: `inspiration-${category.slug}`,
  label: category.label,
  href: category.href,
  direct: true,
  sections: [],
}))

const navRoots: Record<RootKey, { label: string; tabs: NavTab[] }> = {
  products: { label: 'Products', tabs: productTabs },
  inspiration: { label: 'Inspiration', tabs: inspirationTabs },
}

const searchCategoryGroups = [
  { title: 'Categories', links: productTabs.map((tab) => tab.label) },
  { title: 'Inspiration', links: inspirationCategories.map((category) => category.label) },
  { title: 'Help', links: ['FAQs', 'Contact Us'] },
]

const activeTabs = computed(() => navRoots[activeRoot.value].tabs)
const activeDesktopTab = computed(() => activeTabs.value.find((tab: NavTab) => tab.id === activeDesktopTabId.value) ?? activeTabs.value[0])
const mobileTabs = computed(() => navRoots[activeMobileRoot.value].tabs)
const activeMobileTab = computed(() => mobileTabs.value.find((tab: NavTab) => tab.id === activeMobileTabId.value) ?? mobileTabs.value[0])
const activeMobileSection = computed(() => activeMobileTab.value?.sections[activeMobileSectionIndex.value])

// Groups full-width flow menus into the same fixed visual columns as the reference navigation.
const flowSectionColumns = (tab: NavTab) => {
  if (!tab.flow) return []
  return [tab.sections.slice(0, 2), tab.sections.slice(2, 5), tab.sections.slice(5, 7), tab.sections.slice(7)]
}

const preloadLinks = [
  { rel: 'preload', as: 'image' as const, href: searchImage.desktop },
  { rel: 'preload', as: 'image' as const, href: productTabs[0]?.image },
].filter((link): link is { rel: 'preload'; as: 'image'; href: string } => Boolean(link.href))

useHead({
  link: preloadLinks
})

// Locks the search layer while the global stable scrollbar gutter preserves layout width.
const syncSearchScrollLock = (searchOpen: boolean) => {
  if (!import.meta.client) return

  document.documentElement.classList.toggle('dxv-modal-lock', searchOpen)
}

// Locks page scrolling only for the search layer; the mobile drawer must not change viewport width.
watch(isSearchOpen, (searchOpen) => {
  syncSearchScrollLock(searchOpen)
}, { immediate: true })

onBeforeUnmount(() => {
  syncSearchScrollLock(false)
})

// Switches the desktop root menu without selecting or opening a secondary tab.
const setDesktopRoot = (root: RootKey) => {
  activeRoot.value = root
  activeDesktopTabId.value = ''
  isMegaContentOpen.value = false
}

// Opens the tab-specific desktop mega content on secondary navigation hover.
const openDesktopTab = (tabId: string) => {
  const tab = activeTabs.value.find((candidate: NavTab) => candidate.id === tabId)
  if (tab?.direct) return

  activeDesktopTabId.value = tabId
  isMegaContentOpen.value = true
}

// Closes expanded desktop content while preserving the selected root tab row.
const closeMegaContent = () => {
  isMegaContentOpen.value = false
}

// Opens the mobile drawer and resets it to the reference default root state.
const toggleMobileMenu = () => {
  isMenuOpen.value = !isMenuOpen.value
  if (isMenuOpen.value) {
    mobileMenuTransitionName.value = 'dxv-mobile-menu-forward'
    activeMobileRoot.value = activeRoot.value
    mobileMode.value = 'root'
    activeMobileTabId.value = navRoots[activeMobileRoot.value].tabs[0]?.id ?? ''
    activeMobileSectionIndex.value = 0
    mobileSkippedChild.value = false
  }
}

// Closes the mobile navigation after a user selects a menu item.
const closeMenu = () => {
  isMenuOpen.value = false
}

// Opens the account dialog only from the approved utility navigation entry instead of a commerce action.
const handleAccountLink = (link: { label: string }, event: MouseEvent) => {
  if (link.label !== 'My Account') {
    return
  }

  event.preventDefault()
  openAccountDialog()
}

// Closes mobile navigation before delegating an approved My Account link to the shared dialog.
const handleMobileUtilityLink = (link: { label: string }, event: MouseEvent) => {
  handleAccountLink(link, event)
  closeMenu()
}

// Changes the mobile root tab and returns to its first-level list.
const setMobileRoot = (root: RootKey) => {
  if (root === activeMobileRoot.value) return

  const rootOrder = Object.keys(navRoots) as RootKey[]
  mobileMenuTransitionName.value = rootOrder.indexOf(root) > rootOrder.indexOf(activeMobileRoot.value) ? 'dxv-mobile-menu-forward' : 'dxv-mobile-menu-back'
  activeMobileRoot.value = root
  mobileMode.value = 'root'
  activeMobileTabId.value = navRoots[root].tabs[0]?.id ?? ''
  activeMobileSectionIndex.value = 0
  mobileSkippedChild.value = false
}

// Opens the next mobile menu level only for navigation branches with child content.
const openMobileTab = (tab: NavTab) => {
  mobileMenuTransitionName.value = 'dxv-mobile-menu-forward'
  activeMobileTabId.value = tab.id
  activeMobileSectionIndex.value = 0
  mobileSkippedChild.value = tab.sections.length <= 1
  mobileMode.value = tab.sections.length <= 1 ? 'subchild' : 'child'
}

// Opens a concrete mobile section under the current tab.
const openMobileSection = (sectionIndex: number) => {
  mobileMenuTransitionName.value = 'dxv-mobile-menu-forward'
  activeMobileSectionIndex.value = sectionIndex
  mobileSkippedChild.value = false
  mobileMode.value = 'subchild'
}

// Returns the mobile drawer to the previous level.
const goMobileBack = () => {
  mobileMenuTransitionName.value = 'dxv-mobile-menu-back'
  if (mobileMode.value === 'subchild' && !mobileSkippedChild.value) {
    mobileMode.value = 'child'
    return
  }
  mobileMode.value = 'root'
  mobileSkippedChild.value = false
}

// Opens the full-screen search layer while closing the mobile drawer.
const openSearch = () => {
  if (import.meta.client) {
    const image = new Image()
    image.src = searchImage.desktop
  }
  isMenuOpen.value = false
  isSearchOpen.value = true
}

// Closes the full-screen search layer.
const closeSearch = () => {
  isSearchOpen.value = false
}

// Routes the header search form to the shared search results page.
const submitSearch = async () => {
  const query = searchTerm.value.trim()
  isSearchOpen.value = false
  await navigateTo({
    path: '/search',
    query: query ? { q: query } : {}
  })
}
</script>

<template>
  <header class="dxv-header" :class="{ open: isMenuOpen, 'mega-open': isMegaContentOpen }" @mouseleave="closeMegaContent">
    <div class="dxv-topbar" aria-label="Utility navigation">
      <a class="dxv-partner-link" href="#">
        <span class="dxv-partner-icon" aria-hidden="true">
          <svg viewBox="0 0 23 23" fill="none">
            <path d="M5.03125 17.25V19.4063H17.9688V3.59375H5.03125V7.1875" stroke="currentColor" stroke-width="1.5" />
            <path d="M5.03125 8.625L5.03125 15.8125" stroke="currentColor" stroke-width="1.5" />
            <path d="M7.1875 7.1875H2.875" stroke="currentColor" stroke-width="1.5" />
            <path d="M7.1875 15.8125H2.875" stroke="currentColor" stroke-width="1.5" />
            <path d="M13.5892 11.5456C14.7888 12.1752 15.1591 13.5018 15.1591 14.6701C15.1591 14.6701 14.2064 14.6701 11.892 14.6701C9.57772 14.6701 8.625 14.6701 8.625 14.6701C8.625 13.086 9.678 11.1733 11.892 11.1733" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" />
            <path d="M11.8923 11.1733C12.7945 11.1733 13.5258 10.4419 13.5258 9.53977C13.5258 8.6376 12.7945 7.90625 11.8923 7.90625C10.9901 7.90625 10.2588 8.6376 10.2588 9.53977C10.2588 10.4419 10.9901 11.1733 11.8923 11.1733Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" />
          </svg>
        </span>
        Partner Resources
      </a>
      <nav class="dxv-utility-links" aria-label="Account navigation">
        <a v-for="link in utilityLinks" :key="link.label" :href="link.href" @click="handleAccountLink(link, $event)">
          {{ link.label }}
          <span v-if="link.label === 'My Account'" class="dxv-account-icon" aria-hidden="true">
            <svg viewBox="0 0 23 23" fill="none">
              <path d="M15.2338 11.6002C17.8729 12.9854 18.6875 15.904 18.6875 18.4741C18.6875 18.4741 16.5915 18.4741 11.5 18.4741C6.40848 18.4741 4.3125 18.4741 4.3125 18.4741C4.3125 14.9892 6.62912 10.7812 11.5 10.7812" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" />
              <path d="M11.5 10.7813C13.4848 10.7813 15.0938 9.17228 15.0938 7.1875C15.0938 5.20273 13.4848 3.59375 11.5 3.59375C9.51523 3.59375 7.90625 5.20273 7.90625 7.1875C7.90625 9.17228 9.51523 10.7813 11.5 10.7813Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" />
            </svg>
          </span>
        </a>
      </nav>
    </div>

    <div class="dxv-header-main">
      <nav class="dxv-main-left" aria-label="Main navigation">
        <button
          v-for="(root, key) in navRoots"
          :key="key"
          :class="['dxv-main-tab', { active: activeRoot === key }]"
          type="button"
          @click="setDesktopRoot(key as RootKey)"
          @mouseenter="setDesktopRoot(key as RootKey)"
        >
          {{ root.label }}
        </button>
      </nav>

      <a class="dxv-logo" href="/" aria-label="Go to Home page">
        <img :src="logoSrc" alt="MAIDSTONE | DXV" />
      </a>

      <div class="dxv-header-actions">
        <button class="dxv-action-link dxv-icon-action" type="button" aria-label="Open search modal" @click="openSearch">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="m19 20 6 6M13 22.25a8.25 8.25 0 1 0 0-16.5 8.25 8.25 0 0 0 0 16.5Z" stroke="currentColor" stroke-width="1.7" />
          </svg>
        </button>
        <button class="dxv-action-link dxv-icon-action dxv-favorites-button" type="button" aria-label="Favorites" @click="openGuestCommerceDrawer('favorites')">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 26.1S6.25 20.26 6.25 12.86C6.25 9.57 8.79 7 12.04 7C13.89 7 15.53 7.86 16.6 9.19C17.67 7.86 19.31 7 21.16 7C24.41 7 26.95 9.57 26.95 12.86C26.95 20.26 17.2 26.1 17.2 26.1L16.6 26.46L16 26.1Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          </svg>
          <span aria-hidden="true">{{ favoriteCount }}</span>
        </button>
        <button class="dxv-cart-button" type="button" aria-label="Cart" @click="openGuestCommerceDrawer('cart')">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M5.5 7.5H8.4L10.4 20.1H23.2L25.3 11.1H9.05" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="12.3" cy="25" r="1.35" fill="currentColor" />
            <circle cx="21.7" cy="25" r="1.35" fill="currentColor" />
          </svg>
          <span aria-hidden="true">{{ cartItemCount }}</span>
        </button>
      </div>

      <button
        class="dxv-mobile-menu-button"
        type="button"
        :aria-expanded="isMenuOpen"
        aria-controls="dxv-mobile-menu"
        aria-label="Mobile Menu"
        @click="toggleMobileMenu"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 5H22" stroke="currentColor" stroke-width="1.6" />
          <path d="M2 12H22" stroke="currentColor" stroke-width="1.6" />
          <path d="M2 19H22" stroke="currentColor" stroke-width="1.6" />
        </svg>
      </button>
      <button class="dxv-mobile-search-button" type="button" aria-label="Search" @click="openSearch">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="m19 20 6 6M13 22.25a8.25 8.25 0 1 0 0-16.5 8.25 8.25 0 0 0 0 16.5Z" stroke="currentColor" stroke-width="1.7" />
        </svg>
      </button>
      <button class="dxv-mobile-favorites-button" type="button" aria-label="Favorites" @click="openGuestCommerceDrawer('favorites')">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M16 26.1S6.25 20.26 6.25 12.86C6.25 9.57 8.79 7 12.04 7C13.89 7 15.53 7.86 16.6 9.19C17.67 7.86 19.31 7 21.16 7C24.41 7 26.95 9.57 26.95 12.86C26.95 20.26 17.2 26.1 17.2 26.1L16.6 26.46L16 26.1Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        </svg>
        <span aria-hidden="true">{{ favoriteCount }}</span>
      </button>
      <button class="dxv-mobile-cart-button" type="button" aria-label="Cart" @click="openGuestCommerceDrawer('cart')">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M5.5 7.5H8.4L10.4 20.1H23.2L25.3 11.1H9.05" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="12.3" cy="25" r="1.35" fill="currentColor" />
          <circle cx="21.7" cy="25" r="1.35" fill="currentColor" />
        </svg>
        <span aria-hidden="true">{{ cartItemCount }}</span>
      </button>
    </div>

    <nav class="dxv-category-row" aria-label="Category navigation">
      <a
        v-for="tab in activeTabs"
        :key="tab.id"
        :class="{ active: activeDesktopTabId === tab.id && isMegaContentOpen }"
        :href="tab.href"
        @focus="openDesktopTab(tab.id)"
        @mouseenter="openDesktopTab(tab.id)"
      >
        {{ tab.label }}
      </a>
    </nav>

    <div class="dxv-mega-mask" aria-hidden="true" />

    <section class="dxv-mega-panel" :class="`tab-${activeDesktopTab?.id ?? 'none'}`" aria-label="Featured navigation">
      <div
        v-if="activeDesktopTab"
        class="dxv-mega-inner"
        :class="{
          'no-promo': !(activeDesktopTab.description || activeDesktopTab.logo || activeDesktopTab.title),
          'no-right': !activeDesktopTab.image,
          cards: activeDesktopTab.cards?.length,
        }"
      >
        <aside v-if="activeDesktopTab.description || activeDesktopTab.logo || activeDesktopTab.title" class="dxv-mega-promo" :class="{ pattern: activeDesktopTab.pattern }">
          <img v-if="activeDesktopTab.logo" class="dxv-mega-promo-logo" :src="logoSrc" alt="MAIDSTONE | DXV">
          <h3 v-else-if="activeDesktopTab.title">{{ activeDesktopTab.title }}</h3>
          <p v-if="activeDesktopTab.description">{{ activeDesktopTab.description }}</p>
          <nav v-if="activeDesktopTab.cta?.length" aria-label="Featured navigation links">
            <a v-for="link in activeDesktopTab.cta" :key="link.label" :href="link.href">{{ link.label }}</a>
          </nav>
        </aside>

        <div class="dxv-mega-links">
          <div v-if="activeDesktopTab.cards?.length" class="dxv-mega-card-grid">
            <a v-for="card in activeDesktopTab.cards" :key="card.title" class="dxv-mega-card" :href="card.href">
              <img v-if="card.image" :src="card.image" :alt="card.title">
              <span>{{ card.title }}</span>
              <p>{{ card.description }}</p>
            </a>
          </div>
          <nav
            v-else-if="activeDesktopTab.flow"
            class="dxv-mega-flow-columns"
            aria-label="Expanded navigation"
          >
            <div v-for="(column, columnIndex) in flowSectionColumns(activeDesktopTab)" :key="columnIndex" class="dxv-mega-flow-column">
              <section v-for="section in column" :key="section.title" class="dxv-mega-link-group" :class="{ empty: !section.links.length }">
                <a class="dxv-mega-section-title" :href="section.href">{{ section.title }}</a>
                <a v-for="link in section.links" :key="link.label" :href="link.href">{{ link.label }}</a>
              </section>
            </div>
          </nav>
          <nav
            v-else
            class="dxv-mega-section-grid"
            :class="[
              `cols-${activeDesktopTab.centerColumns ?? Math.min(activeDesktopTab.sections.length || 1, 3)}`,
              { 'many-sections': activeDesktopTab.sections.length > 4 },
            ]"
            aria-label="Expanded navigation"
          >
            <section v-for="section in activeDesktopTab.sections" :key="section.title" class="dxv-mega-link-group" :class="{ empty: !section.links.length }">
              <a class="dxv-mega-section-title" :href="section.href">{{ section.title }}</a>
              <a v-for="link in section.links" :key="link.label" :href="link.href">{{ link.label }}</a>
            </section>
          </nav>
        </div>

        <figure v-if="activeDesktopTab.image" class="dxv-mega-image">
          <img :src="activeDesktopTab.image" :alt="activeDesktopTab.title ?? activeDesktopTab.label">
        </figure>
      </div>
    </section>

    <div class="dxv-mobile-drawer-layer" :class="{ open: isMenuOpen }" aria-hidden="true" @click="closeMenu" />
    <aside id="dxv-mobile-menu" class="dxv-mobile-panel" :class="{ open: isMenuOpen }" aria-label="Mobile navigation" :aria-hidden="!isMenuOpen">
      <div class="dxv-mobile-panel-top">
        <div class="dxv-mobile-root-tabs">
          <button
            v-for="(root, key) in navRoots"
            :key="key"
            class="dxv-mobile-root-tab"
            :class="{ active: activeMobileRoot === key }"
            type="button"
            @click="setMobileRoot(key as RootKey)"
          >
            {{ root.label }}
          </button>
        </div>
        <button class="dxv-mobile-close-button" type="button" aria-label="Close navigation" @click="closeMenu">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M6.34375 7.25L21.7233 22.6296" stroke="currentColor" stroke-width="2" />
            <path d="M6.34375 22.6562L21.7233 7.27667" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
      </div>

      <div class="dxv-mobile-panel-body">
        <Transition :name="mobileMenuTransitionName">
          <div v-if="mobileMode === 'root'" :key="`root-${activeMobileRoot}`" class="dxv-mobile-view dxv-mobile-root-view">
            <nav
              class="dxv-mobile-primary-list"
              :aria-label="activeMobileRoot === 'inspiration' ? 'Mobile inspiration categories' : 'Mobile product navigation'"
            >
              <template v-for="tab in mobileTabs" :key="tab.id">
                <NuxtLink
                  v-if="tab.direct"
                  class="dxv-mobile-leaf-item"
                  :to="tab.href"
                  @click="closeMenu"
                >
                  <span>{{ tab.label }}</span>
                </NuxtLink>
                <button v-else class="dxv-mobile-primary-item" type="button" @click="openMobileTab(tab)">
                  <span>{{ tab.label }}</span>
                  <svg viewBox="0 0 9 15" fill="none" aria-hidden="true">
                    <path d="M1.20215 1.20209L7.50215 7.50209L1.20215 13.8021" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" />
                  </svg>
                </button>
              </template>
            </nav>

            <nav class="dxv-mobile-utility-list" aria-label="Mobile utility navigation">
              <a v-for="link in mobileUtilityLinks" :key="link.label" :href="link.href" @click="handleMobileUtilityLink(link, $event)">
                <span class="dxv-mobile-utility-icon" aria-hidden="true">
                  <svg viewBox="0 0 26 26" fill="none">
                    <circle cx="13" cy="13" r="10.525" stroke="currentColor" stroke-width="1.7" />
                    <path d="M14.1931 8.84005C13.9223 8.84005 13.6948 8.75338 13.5106 8.58005C13.3373 8.40672 13.2506 8.18463 13.2506 7.9138C13.2506 7.64297 13.3373 7.42088 13.5106 7.24755C13.6948 7.07422 13.9223 6.98755 14.1931 6.98755C14.4531 6.98755 14.6752 7.07422 14.8594 7.24755C15.0435 7.42088 15.1356 7.64297 15.1356 7.9138C15.1356 8.18463 15.0435 8.40672 14.8594 8.58005C14.6752 8.75338 14.4531 8.84005 14.1931 8.84005ZM11.6094 18.6876L13.0231 10.6276H14.3881L12.9744 18.6876H11.6094Z" fill="currentColor" />
                  </svg>
                </span>
                <span>{{ link.label }}</span>
              </a>
            </nav>
          </div>

          <div v-else-if="mobileMode === 'child'" key="child" class="dxv-mobile-view dxv-mobile-child-view">
            <div class="dxv-mobile-child-header">
              <button type="button" @click="goMobileBack">
                <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true">
                  <path d="M6.21094 11.069L1.21094 6.13554L6.21094 1.20211" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" />
                </svg>
                <span>Back</span>
              </button>
              <h3>{{ activeMobileTab?.label }}</h3>
            </div>
            <nav class="dxv-mobile-primary-list dxv-mobile-section-list" aria-label="Mobile section navigation">
              <button v-for="(section, index) in activeMobileTab?.sections" :key="section.title" class="dxv-mobile-primary-item" type="button" @click="openMobileSection(index)">
                <span>{{ section.title }}</span>
                <svg viewBox="0 0 9 15" fill="none" aria-hidden="true">
                  <path d="M1.20215 1.20209L7.50215 7.50209L1.20215 13.8021" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" />
                </svg>
              </button>
            </nav>
          </div>

          <div v-else key="subchild" class="dxv-mobile-view dxv-mobile-subchild-view">
            <div class="dxv-mobile-child-header">
              <button type="button" @click="goMobileBack">
                <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true">
                  <path d="M6.21094 11.069L1.21094 6.13554L6.21094 1.20211" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" />
                </svg>
                <span>Back</span>
              </button>
              <h3>{{ activeMobileSection?.title ?? activeMobileTab?.label }}</h3>
            </div>
            <div class="dxv-mobile-subchild">
              <nav v-if="activeMobileSection" class="dxv-mobile-sublist" aria-label="Mobile sub navigation">
                <a class="dxv-mobile-sublist-title" :href="activeMobileSection.href" @click="closeMenu">
                  <span>{{ activeMobileSection.title }}</span>
                </a>
                <a v-for="link in activeMobileSection.links" :key="link.label" :href="link.href" @click="closeMenu">
                  <span>{{ link.label }}</span>
                </a>
              </nav>
              <nav v-else-if="activeMobileTab?.cards?.length" class="dxv-mobile-card-list" aria-label="Mobile inspiration navigation">
                <a v-for="card in activeMobileTab.cards" :key="card.title" :href="card.href" @click="closeMenu">
                  <span>{{ card.title }}</span>
                  <small>{{ card.description }}</small>
                </a>
              </nav>
            </div>
          </div>
        </Transition>
      </div>
    </aside>

    <Transition name="dxv-search-layer">
      <div v-if="isSearchOpen" class="dxv-search-modal" role="dialog" aria-modal="true" aria-label="Search" @click.self="closeSearch">
        <button class="dxv-search-close" type="button" aria-label="Close search" @click="closeSearch">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M6.34375 7.25L21.7233 22.6296" stroke="currentColor" stroke-width="2" />
            <path d="M6.34375 22.6562L21.7233 7.27667" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
        <div class="dxv-search-content">
          <form class="dxv-search-form" role="search" action="/search" method="get" @submit.prevent="submitSearch">
            <span class="dxv-search-field-icon" aria-hidden="true">
              <svg fill="none" viewBox="0 0 32 32">
                <path d="m19 20 6 6M13 22.25a8.25 8.25 0 1 0 0-16.5 8.25 8.25 0 0 0 0 16.5Z" stroke="currentColor" stroke-width="1.7" />
              </svg>
            </span>
            <label for="dxv-search-input">Search</label>
            <input id="dxv-search-input" v-model="searchTerm" name="q" type="search" autocomplete="off" placeholder="Search" autofocus>
          </form>
          <div class="dxv-search-categories">
            <nav class="dxv-search-card" aria-label="Search Categories">
              <p>{{ searchCategoryGroups[0]?.title }}</p>
              <a v-for="link in searchCategoryGroups[0]?.links" :key="link" href="#">{{ link }}</a>
            </nav>
            <div class="dxv-search-card dxv-search-card-combined">
              <nav v-for="group in searchCategoryGroups.slice(1)" :key="group.title" :aria-label="`Search ${group.title}`">
                <p>{{ group.title }}</p>
                <a v-for="link in group.links" :key="link" href="#">{{ link }}</a>
              </nav>
            </div>
            <figure class="dxv-search-image">
              <img :src="searchImage.desktop" :alt="searchImage.alt">
            </figure>
          </div>
        </div>
      </div>
    </Transition>
  </header>
</template>
