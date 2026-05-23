export type Verdict = 'safe' | 'suspicious' | 'dangerous' | 'unknown'
export type ScanStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type InputType = 'url' | 'domain' | 'email' | 'header' | 'signature' | 'batch'
export type UserRole = 'admin' | 'member'
export type Plan = 'free' | 'pro' | 'team' | 'msp'

export interface Organization {
  id: string
  name: string
  slug: string
  plan: Plan
  scan_count_this_month: number
  created_at: string
}

export interface User {
  id: string
  organization_id: string
  full_name: string
  role: UserRole
  created_at: string
}

export interface Scan {
  id: string
  organization_id: string
  user_id: string
  input_type: InputType
  raw_input: string
  email_parsed_data?: EmailParsedData
  extracted_indicators?: ExtractedIndicators
  status: ScanStatus
  risk_score?: number
  confidence_score?: number
  verdict?: Verdict
  ai_explanation?: string
  recommended_action?: string
  scan_duration_ms?: number
  created_at: string
  completed_at?: string
}

export interface EmailParsedData {
  from_name?: string
  from_email?: string
  from_domain?: string
  reply_to?: string
  return_path?: string
  subject?: string
  urls_found: string[]
  domains_found: string[]
  claimed_brand?: string
  urgency_phrases: string[]
  has_signature: boolean
  signature_domain?: string
  signature_company?: string
  signature_phone?: string
}

export interface ExtractedIndicators {
  urls: string[]
  domains: string[]
  ips: string[]
  emails: string[]
  phone_numbers: string[]
  brands: string[]
}

export interface EvidenceItem {
  id: string
  scan_id: string
  signal_type: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'good'
  title: string
  detail?: string
  score_impact: number
  created_at: string
}

export interface VendorResult {
  id: string
  scan_id: string
  vendor_name: string
  verdict?: string
  raw_response?: Record<string, unknown>
  checked_at: string
}

export interface ScanFeedback {
  id: string
  scan_id: string
  organization_id: string
  user_id: string
  feedback_type: 'false_positive' | 'false_negative' | 'correct' | 'uncertain'
  comment?: string
  created_at: string
}

export const PLAN_LIMITS = {
  free:  { scans_per_day: 20,   scans_per_month: 100,   users: 1,   watchlist: 0,   api: false, pdf: false },
  pro:   { scans_per_day: 50,   scans_per_month: 500,   users: 5,   watchlist: 20,  api: false, pdf: true  },
  team:  { scans_per_day: 200,  scans_per_month: 2000,  users: 999, watchlist: 100, api: true,  pdf: true  },
  msp:   { scans_per_day: 1000, scans_per_month: 10000, users: 999, watchlist: 500, api: true,  pdf: true  },
} as const

export const PLAN_PRICING = {
  free: 0,
  pro: 79,
  team: 149,
  msp: 399,
} as const
