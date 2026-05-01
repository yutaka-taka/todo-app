'use strict'
/**
 * グレード別ブラインド最適化を連続実行してAlgorithmConfigに保存。
 * 実行: node scripts/optimize_by_grade.js
 *
 * 1. G1専用 → gradeWeights.G1 に保存
 * 2. G2G3専用 → gradeWeights.G2G3 に保存
 */
const { execSync } = require('child_process')
const path = require('path')

const script = path.join(__dirname, 'full_blind_optimize.js')

function run(gradeFilter) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${gradeFilter} 最適化開始`)
  console.log('='.repeat(60))
  try {
    execSync(`node "${script}" --grade ${gradeFilter} --save`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    })
  } catch (e) {
    console.error(`${gradeFilter} 最適化中にエラーが発生しました:`, e.message)
    process.exit(1)
  }
}

run('G1')
run('G2G3')

console.log('\n=== 完了 ===')
console.log('G1専用重み・G2G3専用重みを AlgorithmConfig に保存しました。')
console.log('predict API は次回から race.grade に応じた重みを自動適用します。')
