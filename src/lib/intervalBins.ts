export type IntervalBin =
  | 'rensen'      // 連戦: 7-13日
  | 'standard2'   // 中2週: 14-20日
  | 'standard3'   // 中3週: 21-27日（ベスト帯）
  | 'standard4'   // 中4週: 28-34日（ベスト帯）
  | 'standard5'   // 中5週: 35-41日（ベスト帯）
  | 'medium'      // 中6-8週: 42-62日
  | 'shortRest'   // 短期休養: 63-119日
  | 'midRest'     // 中期休養: 120-180日
  | 'longRest'    // 長期休養: 181日以上

export function getIntervalBin(days: number): IntervalBin {
  if (days <= 13)  return 'rensen'
  if (days <= 20)  return 'standard2'
  if (days <= 27)  return 'standard3'
  if (days <= 34)  return 'standard4'
  if (days <= 41)  return 'standard5'
  if (days <= 62)  return 'medium'
  if (days <= 119) return 'shortRest'
  if (days <= 180) return 'midRest'
  return 'longRest'
}
