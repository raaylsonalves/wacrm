import { describe, it, expect } from 'vitest'
import { followupPromptSection } from './followup-prompt'

describe('followupPromptSection', () => {
  it('first attempt is a gentle reminder', () => {
    const s = followupPromptSection({ attempt: 1, final: false })
    expect(s).toContain('first follow-up')
    expect(s).not.toContain('LAST')
  })

  it('later attempts ask not to repeat', () => {
    const s = followupPromptSection({ attempt: 2, final: false })
    expect(s).toContain('number 2')
    expect(s).toContain('Do not repeat')
  })

  it('the final attempt offers to stop the messages', () => {
    const s = followupPromptSection({ attempt: 3, final: true })
    expect(s).toContain('LAST follow-up')
    expect(s).toContain('stop sending messages')
  })

  it('appends the account guidance', () => {
    expect(
      followupPromptSection({ attempt: 1, final: false, custom: '  fale de prazos ' })
    ).toContain('fale de prazos')
  })
})
