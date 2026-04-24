import { NextRequest, NextResponse } from 'next/server'

const VENUE_COORDS: Record<string, { lat: number; lon: number }> = {
  '東京': { lat: 35.7408, lon: 139.4985 },
  '中山': { lat: 35.7730, lon: 140.0155 },
  '阪神': { lat: 34.7581, lon: 135.3683 },
  '京都': { lat: 34.9043, lon: 135.7112 },
  '中京': { lat: 35.0119, lon: 136.8840 },
  '福島': { lat: 37.7661, lon: 140.4283 },
  '新潟': { lat: 37.8770, lon: 139.0609 },
  '函館': { lat: 41.7691, lon: 140.7263 },
  '札幌': { lat: 43.0658, lon: 141.2999 },
  '小倉': { lat: 33.8583, lon: 130.8613 },
}

function wmoToJapanese(code: number): string {
  if (code <= 3) return '晴れ〜曇り'
  if (code === 51 || code === 53 || code === 55) return '霧雨'
  if (code === 61 || code === 63 || code === 65) return code === 61 ? '雨（小）' : code === 63 ? '雨（中）' : '雨（大）'
  if (code === 71 || code === 73 || code === 75) return '雪'
  if (code === 80 || code === 81 || code === 82) return 'にわか雨'
  if (code === 95 || code === 99) return '雷雨'
  return '不明'
}

function wmoToIcon(code: number): string {
  if (code <= 1) return '☀️'
  if (code <= 3) return '⛅'
  if (code === 51 || code === 53 || code === 55) return '🌦️'
  if (code >= 61 && code <= 65) return '🌧️'
  if (code >= 71 && code <= 75) return '❄️'
  if (code >= 80 && code <= 82) return '🌦️'
  if (code === 95 || code === 99) return '⛈️'
  return '🌡️'
}

function deriveCondition(precipMm: number, weatherCode: number): string {
  if (precipMm === 0 && weatherCode <= 3) return '良'
  if (precipMm < 1.5) return '稍重'
  if (precipMm < 4) return '重'
  return '不良'
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const venue = searchParams.get('venue') ?? '東京'
    const date = searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

    const coords = VENUE_COORDS[venue] ?? VENUE_COORDS['東京']

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=precipitation,weathercode,temperature_2m&timezone=Asia%2FTokyo&forecast_days=7`

    const res = await fetch(url, { next: { revalidate: 3600 } })
    if (!res.ok) throw new Error(`OpenMeteo API error: ${res.status}`)

    const json = await res.json()
    const times: string[] = json.hourly.time
    const precips: number[] = json.hourly.precipitation
    const codes: number[] = json.hourly.weathercode
    const temps: number[] = json.hourly.temperature_2m

    // Find the slot closest to 15:00 on the given date
    const target15 = `${date}T15:00`
    let bestIdx = 0
    let bestDiff = Infinity
    for (let i = 0; i < times.length; i++) {
      if (!times[i].startsWith(date)) continue
      const diff = Math.abs(new Date(times[i]).getTime() - new Date(target15).getTime())
      if (diff < bestDiff) {
        bestDiff = diff
        bestIdx = i
      }
    }

    const precipMm = precips[bestIdx] ?? 0
    const weatherCode = codes[bestIdx] ?? 0
    const temperature = Math.round((temps[bestIdx] ?? 20) * 10) / 10
    const weather = wmoToJapanese(weatherCode)
    const icon = wmoToIcon(weatherCode)
    const conditionEstimate = deriveCondition(precipMm, weatherCode)

    return NextResponse.json({ weather, temperature, precipMm, conditionEstimate, icon })
  } catch (error) {
    console.error('Weather API error:', error)
    const message = error instanceof Error ? error.message : '天気情報の取得に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
