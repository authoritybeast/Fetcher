import test from 'node:test';
import assert from 'node:assert/strict';
import { capHtml, cleanSalary, cleanUrl, convertSalary, detectWorkMode, mapJobType, normalizeCountry, parseLocation, parseSalaryText, stateCode, toIsoDate, unescapeIfEscaped } from '../src/normalize.mjs';

test('stateCode: codes and full names, DC, and the Georgia trap', () => {
  assert.equal(stateCode('tx'), 'TX');
  assert.equal(stateCode('Texas'), 'TX');
  assert.equal(stateCode('new   york'), 'NY');
  assert.equal(stateCode('Washington DC'), 'DC');
  assert.equal(stateCode('District of Columbia'), 'DC');
  assert.equal(stateCode('Georgia'), undefined, 'bare Georgia is the country');
  assert.equal(stateCode('Georgia', { allowGeorgia: true }), 'GA');
  assert.equal(stateCode('ON'), undefined, 'Ontario is not a state');
  assert.equal(stateCode(''), undefined);
});

test('parseLocation: City, ST / ZIP / full names', () => {
  assert.deepEqual(parseLocation('Austin, TX'), { city: 'Austin', region: 'TX', country: 'US' });
  assert.deepEqual(parseLocation('San Francisco, CA 94105'), { city: 'San Francisco', region: 'CA', postal: '94105', country: 'US' });
  assert.deepEqual(parseLocation('Dallas, Texas, United States'), { city: 'Dallas', region: 'TX', country: 'US' });
  assert.deepEqual(parseLocation('Washington, DC'), { city: 'Washington', region: 'DC', country: 'US' });
  assert.equal(parseLocation('Atlanta, Georgia, USA').region, 'GA');
  assert.equal(parseLocation('Portland, OR').region, 'OR', 'OR is Oregon, not the word "or"');
  assert.equal(parseLocation('Indianapolis, IN').region, 'IN', 'IN is Indiana, not the word "in"');
});

test('parseLocation: remote + US phrases', () => {
  for (const t of ['Remote - US', 'United States', 'USA', 'Anywhere in the US', 'Remote, USA']) {
    const p = parseLocation(t);
    assert.equal(p.country, 'US', t);
    assert.equal(p.workMode, 'remote', t);
    assert.equal(p.region, undefined, t);
  }
  assert.equal(parseLocation('New York, NY (Remote)').workMode, 'remote');
  assert.equal(parseLocation('Hybrid - Chicago, IL').workMode, 'hybrid');
});

test('parseLocation: never guesses US', () => {
  assert.deepEqual(parseLocation('Berlin'), {});
  assert.deepEqual(parseLocation('Tbilisi, Georgia'), {}, 'Georgia the country');
  assert.deepEqual(parseLocation('Toronto, Canada'), { city: 'Toronto', country: 'CA' });
  assert.deepEqual(parseLocation('Remote'), { workMode: 'remote' });
  assert.deepEqual(parseLocation('CA'), {}, 'a bare 2-letter code without a city is ambiguous');
  assert.deepEqual(parseLocation(''), {});
  assert.deepEqual(parseLocation(null), {});
});

test('normalizeCountry', () => {
  assert.equal(normalizeCountry('us'), 'US');
  assert.equal(normalizeCountry('United States'), 'US');
  assert.equal(normalizeCountry('uk'), 'GB');
  assert.equal(normalizeCountry('Germany'), 'DE');
  assert.equal(normalizeCountry('Atlantis'), undefined);
  assert.equal(normalizeCountry(''), undefined);
});

test('detectWorkMode', () => {
  assert.equal(detectWorkMode('Remote'), 'remote');
  assert.equal(detectWorkMode('Hybrid (3 days)'), 'hybrid');
  assert.equal(detectWorkMode('on-site'), 'onsite');
  assert.equal(detectWorkMode('', 'work from home'), 'remote');
  assert.equal(detectWorkMode('Austin, TX'), undefined, 'a place is not a mode');
  assert.equal(detectWorkMode(true, undefined), undefined);
});

test('mapJobType', () => {
  assert.equal(mapJobType('Full-time'), 'full-time');
  assert.equal(mapJobType('FullTime'), 'full-time');
  assert.equal(mapJobType('full_time'), 'full-time');
  assert.equal(mapJobType('Part time'), 'part-time');
  assert.equal(mapJobType('Contractor'), 'contract');
  assert.equal(mapJobType('Internship'), 'internship');
  assert.equal(mapJobType('freelance'), 'freelance');
  assert.equal(mapJobType('Multiple Schedules'), undefined);
});

test('cleanUrl: https only, utm_* removed, no credentials', () => {
  assert.equal(cleanUrl('https://x.test/a?utm_source=a&id=3&UTM_medium=b'), 'https://x.test/a?id=3');
  assert.equal(cleanUrl('https://x.test/a?utm_source=a'), 'https://x.test/a');
  assert.equal(cleanUrl('http://x.test/a'), undefined);
  assert.equal(cleanUrl('https://user:pw@x.test/a'), undefined);
  assert.equal(cleanUrl('javascript:alert(1)'), undefined);
  assert.equal(cleanUrl('/relative'), undefined);
  assert.equal(cleanUrl('/relative', 'https://x.test/base'), 'https://x.test/relative');
  assert.equal(cleanUrl('https://x.test/has space'), undefined);
  assert.equal(cleanUrl(`https://x.test/${'a'.repeat(2100)}`), undefined);
});

test('capHtml: cuts at the limit without a half tag or entity', () => {
  assert.equal(capHtml('<p>short</p>', 50), '<p>short</p>');
  const cut = capHtml(`<p>${'a'.repeat(40)}</p><b class="x">bold</b>`, 55);
  assert.ok(cut.length <= 55);
  assert.ok(!/<[^>]*$/.test(cut), `half tag left: ${cut}`);
  assert.ok(!/&[#a-z0-9]*$/i.test(capHtml(`${'a'.repeat(48)}&amp;more`, 50)));
  assert.equal(capHtml('x'.repeat(60_000)).length, 50_000);
});

test('unescapeIfEscaped decodes only escaped HTML', () => {
  assert.equal(unescapeIfEscaped('&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;'), '<p>Hi &amp; bye</p>');
  assert.equal(unescapeIfEscaped('<p>Already &lt;html&gt;</p>'), '<p>Already &lt;html&gt;</p>');
});

test('convertSalary uses 2080 h / 260 d / 52 w / 12 m', () => {
  assert.equal(convertSalary(20, 'hour', 'year'), 41600);
  assert.equal(convertSalary(52000, 'year', 'hour'), 25);
  assert.equal(convertSalary(1000, 'week', 'year'), 52000);
  assert.equal(convertSalary(5000, 'month', 'year'), 60000);
  assert.equal(convertSalary(100, 'day', 'week'), 500);
  assert.equal(convertSalary(NaN, 'hour', 'year'), undefined);
  assert.equal(convertSalary(1, 'fortnight', 'year'), undefined);
});

test('cleanSalary is all-or-nothing and checks plausibility', () => {
  assert.deepEqual(cleanSalary({ min: 18, max: 22, period: 'hour', currency: 'usd' }), { salary_min: 18, salary_max: 22, salary_period: 'hour', salary_currency: 'USD' });
  assert.deepEqual(cleanSalary({ min: '46000.0', max: '61000.0', period: 'year' }), { salary_min: 46000, salary_max: 61000, salary_period: 'year', salary_currency: 'USD' });
  assert.deepEqual(cleanSalary({ min: 20, period: 'hour' }), { salary_min: 20, salary_max: 20, salary_period: 'hour', salary_currency: 'USD' });
  assert.deepEqual(cleanSalary({ min: 30, max: 20, period: 'hour' }), {}, 'min > max');
  assert.deepEqual(cleanSalary({ min: 0, max: 0, period: 'year' }), {});
  assert.deepEqual(cleanSalary({ min: 45, max: 50, period: 'year' }), {}, '45 a year is the wrong unit');
  assert.deepEqual(cleanSalary({ min: 90000, max: 100000, period: 'hour' }), {}, '90000 an hour is the wrong unit');
  assert.deepEqual(cleanSalary({ min: 20, max: 25, period: 'fortnight' }), {});
  assert.deepEqual(cleanSalary({ min: 20, max: 25, period: 'hour', currency: 'DOLLARS' }), {});
  assert.deepEqual(cleanSalary({}), {});
});

test('parseSalaryText: only the unambiguous shape', () => {
  assert.deepEqual(parseSalaryText('Pay is $20 - $25 per hour plus tips'), { salary_min: 20, salary_max: 25, salary_period: 'hour', salary_currency: 'USD' });
  assert.deepEqual(parseSalaryText('$20-$25/hr'), { salary_min: 20, salary_max: 25, salary_period: 'hour', salary_currency: 'USD' });
  assert.deepEqual(parseSalaryText('$60,000 - $80,000 a year'), { salary_min: 60000, salary_max: 80000, salary_period: 'year', salary_currency: 'USD' });
  assert.deepEqual(parseSalaryText('up to $25 per hour'), {}, 'single number');
  assert.deepEqual(parseSalaryText('20 - 25 per hour'), {}, 'no currency sign');
  assert.deepEqual(parseSalaryText('$20 - $25'), {}, 'no period');
  assert.deepEqual(parseSalaryText('$20 - $25 per hour or $40,000 - $50,000 per year'), {}, 'two ranges');
  assert.deepEqual(parseSalaryText(''), {});
});

test('toIsoDate', () => {
  assert.equal(toIsoDate('2026-10-01'), '2026-10-01T00:00:00.000Z');
  assert.equal(toIsoDate(1790000000), new Date(1790000000 * 1000).toISOString());
  assert.equal(toIsoDate(1790000000000), new Date(1790000000000).toISOString());
  assert.equal(toIsoDate('1790000000'), new Date(1790000000 * 1000).toISOString());
  assert.equal(toIsoDate('Mon, 05 Oct 2026 10:00:00 GMT'), '2026-10-05T10:00:00.000Z');
  assert.equal(toIsoDate('nonsense'), undefined);
  assert.equal(toIsoDate(''), undefined);
  assert.equal(toIsoDate('2999-01-01', Date.UTC(2026, 9, 1)), '2026-10-01T00:00:00.000Z', 'future dates are clamped to now');
});
