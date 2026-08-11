import { describe, it, expect } from 'vitest'
import { GALLERY_API, registerPageUrl } from '../lib/galleryApi.js'

describe('GALLERY_API', () => {
  it('exposes the register endpoint', () => {
    expect(GALLERY_API.register).toBe('gallery/api/register')
  })
})

describe('registerPageUrl', () => {
  it('appends the register page path to the registry base', () => {
    expect(registerPageUrl('https://m.example.com')).toBe('https://m.example.com/gallery/register')
  })

  it('normalizes trailing slashes on the base', () => {
    expect(registerPageUrl('https://m.example.com/')).toBe('https://m.example.com/gallery/register')
    expect(registerPageUrl('https://m.example.com///')).toBe(
      'https://m.example.com/gallery/register',
    )
  })
})
