import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeIdentity, matchEpisode, seekTarget} from '../public/playback-utils.js';

const line = (names, name = '主线') => ({name,episodes:names.map(name => ({name}))});

test('episode matching recognizes Chinese, padded numbers and E/EP forms', () => {
  for (const name of ['第1集','第 01 集','01','1','E01','EP001','Episode 1','第一集']) {
    assert.equal(matchEpisode(name,[line(['第02集','第01集'])])?.episode,1,name);
  }
  assert.equal(episodeIdentity('第一百零二集').number,102);
  assert.equal(matchEpisode('第十二集',[line(['EP012'])])?.episode,0);
});

test('episode matching never maps by index or drops a split/season identity', () => {
  assert.equal(matchEpisode('第3集',[line(['01','02'])]),null);
  assert.equal(matchEpisode('第1集上',[line(['01','第1集下'])]),null);
  assert.equal(matchEpisode('第1集上',[line(['第1集下','第01集上'])])?.episode,1);
  assert.equal(matchEpisode('S02E01',[line(['第1集','S01E01'])]),null);
  assert.equal(matchEpisode('S02E01',[line(['第二季第一集'])])?.episode,0);
  assert.equal(matchEpisode('预告片',[line(['正片'])]),null);
  assert.equal(matchEpisode('20261113上',[line(['20261113下'])]),null);
});

test('matching prefers equivalent line, allows a single movie but not series index fallback', () => {
  const lines = [line(['01'],'备线'),line(['E01'],'主线')];
  assert.equal(matchEpisode('第一集',lines,{preferredLine:'主线'})?.line,1);
  assert.equal(matchEpisode('高清',[line(['正片'])],{movie:true,sourceEpisodeCount:1})?.episode,0);
  assert.equal(matchEpisode('高清',[line(['正片'])],{movie:false,sourceEpisodeCount:1}),null);
  assert.equal(matchEpisode('上集',[line(['正片'])],{movie:true,sourceEpisodeCount:2}),null);
});

test('single movie fallback excludes trailers, extras and commentary in either source', () => {
  const options = {movie:true,sourceEpisodeCount:1};
  for (const name of ['预告片','幕后花絮','电影解说','Trailer HD','Teaser','导演访谈','Commentary','Behind the scenes']) {
    assert.equal(matchEpisode('正片',[line([name])],options),null,name);
    assert.equal(matchEpisode(name,[line(['正片'])],options),null,name);
  }
  const lines = [line(['预告片'],'主线'),line(['蓝光'],'备线')];
  assert.equal(matchEpisode('高清',lines,{...options,preferredLine:'主线'})?.line,1);
  assert.equal(matchEpisode('预告片',[line(['预告片'])],options)?.episode,0);
});

test('resume waits for metadata and seekable range then clamps only to actual duration', () => {
  const ranges = values => ({length:values.length,start:index=>values[index][0],end:index=>values[index][1]});
  assert.equal(seekTarget(120,NaN,ranges([])),null);
  assert.equal(seekTarget(120,300,ranges([])),null);
  assert.equal(seekTarget(120,300,ranges([[0,30]])),null);
  assert.equal(seekTarget(120,300,ranges([[0,300]])),120);
  assert.equal(seekTarget(120,90,ranges([[0,90]])),89.75);
  assert.equal(seekTarget(0,300,ranges([])),0);
});
