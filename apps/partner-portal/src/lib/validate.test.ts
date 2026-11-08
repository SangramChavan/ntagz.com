import { describe, expect, it } from 'vitest';
import * as v from './validate';
import { fileSize, label, rupees } from './format';
import { resumeStep, stages, stepOfField, REQUIRED_DOCS } from './steps';
import type { Application, DocRow } from '../types';

describe('validators', () => {
  it('pincode', () => { expect(v.pincode('411001')).toBe(true); expect(v.pincode('011001')).toBe(false); expect(v.pincode('4110')).toBe(false); });
  it('phone normalises Indian numbers', () => { expect(v.phone('+91 99601 60016')).toBe('9960160016'); expect(v.phone('09960160016')).toBe('9960160016'); expect(v.phone('1234567890')).toBeNull(); });
  it('pan', () => { expect(v.pan(' abcde1234f ')).toBe('ABCDE1234F'); expect(v.pan('12345ABCDE')).toBeNull(); });
  it('email and code', () => { expect(v.email('a@b.co')).toBe(true); expect(v.email('a@b')).toBe(false); expect(v.code('123456')).toBe(true); expect(v.code('12345')).toBe(false); });
});
describe('format', () => {
  it('rupees in lakh grouping', () => { expect(rupees(9999900)).toBe('₹99,999'); expect(rupees(2499900)).toBe('₹24,999'); });
  it('fileSize', () => { expect(fileSize(2048)).toBe('2 KB'); expect(fileSize(5 * 1048576)).toBe('5.0 MB'); });
  it('label', () => expect(label('documents_required')).toBe('Documents required'));
});
const app = (o: Partial<Application> = {}, form: Application['form'] = {}): Application => ({ id: 'a', status: 'draft', typeKey: 'flex', businessName: null, city: null, state: null, pincode: null, panLast4: null, decisionNote: null, submittedAt: null, ...o, form });
const doc = (type: DocRow['type'], status: DocRow['status'] = 'uploaded'): DocRow => ({ id: type, type, mime: 'image/png', size: 1, status, note: null });
describe('wizard resume', () => {
  it('starts at category with no application', () => expect(resumeStep(null, [])).toBe(0));
  it('goes to the first incomplete step', () => {
    expect(resumeStep(app(), [])).toBe(1);
    const biz = app({ businessName: 'B', city: 'Pune', state: 'Maharashtra', pincode: '411001' }, { business_type: 'Retail shop' });
    expect(resumeStep(biz, [])).toBe(2);
    const me = app({ ...biz, panLast4: '234F' }, { business_type: 'Retail shop', name: 'A', phone: '9960160016' });
    expect(resumeStep(me, [])).toBe(3);
    const cap = app({ ...me }, { ...me.form, investment_capacity: '1l_to_3l' });
    expect(resumeStep(cap, [])).toBe(4);
    expect(resumeStep(cap, REQUIRED_DOCS.map((t) => doc(t)))).toBe(5);
    expect(resumeStep(cap, [doc('pan'), doc('address_proof', 'rejected')])).toBe(4);
  });
  it('maps server field errors back to steps', () => { expect(stepOfField('pincode')).toBe(1); expect(stepOfField('pan')).toBe(2); expect(stepOfField('document_pan')).toBe(4); expect(stepOfField('whatever')).toBe(5); });
});
describe('status stages', () => {
  it('marks progress', () => {
    const s = stages('under_review', null); expect(s.map((x) => x.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo', 'todo']);
    const p = stages('approved', 'payment_pending'); expect(p.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'todo', 'todo']);
    expect(stages('approved', 'active')[6]?.state).toBe('done');
  });
  it('documents_required shows as still under review', () => expect(stages('documents_required', null)[1]?.state).toBe('current'));
});
