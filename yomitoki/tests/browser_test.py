"""Browser UI regression tests. All external network requests are intercepted.

Needs Playwright for Python and a Chromium executable. Does not call Gemini.
Run: python tests/browser_test.py --chromium /usr/bin/chromium
"""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SNAP = json.loads((ROOT / 'fixtures/photo-screen-snapshot.json').read_text())

def run(chromium: str, output: Path, baseline: Path | None = None) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    checks: list[str] = []
    api_counts: dict[str, int] = {}
    page_errors: list[str] = []
    first = copy.deepcopy(SNAP['result'])
    # Adversarial mock: force the model's representative to generic red for each multi-flag segment.
    # This is TEST DATA, not a claim about the primary field in the user's raw API response.
    for seg in first['segments']:
        if seg['flags']:
            seg['primary'] = '根拠なき断定'
    second = {'segments':[{'text':first['remeasured'], 'type':'意見','flags':[], 'phrase':'','note':''}]}
    def response(body):
        return {'candidates':[{'content':{'parts':[{'text':json.dumps(body,ensure_ascii=False)}]}}]}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
        def page_for(label, width=1280, height=900, mode='normal'):
            context = browser.new_context(viewport={'width':width,'height':height}, reduced_motion='reduce', locale='ja-JP')
            page = context.new_page()
            page.on('pageerror', lambda err: page_errors.append(str(err)))
            requests=[]
            def route_request(route):
                url=route.request.url
                if urlparse(url).hostname == 'generativelanguage.googleapis.com':
                    if route.request.method == 'OPTIONS':
                        route.fulfill(status=204, headers={'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, x-goog-api-key','Access-Control-Allow-Methods':'POST, OPTIONS'})
                        return
                    requests.append(route.request.post_data_json)
                    # Never pass an API request through. No external service is called.
                    if mode == 'error':
                        route.fulfill(status=429, content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'error':{'message':'Mock quota error'}}))
                    elif mode == 'assertion-only':
                        if len(requests)==1:
                            f=copy.deepcopy(first)
                            for s in f['segments']:
                                if s['flags']: s['flags']=['根拠なき断定']
                            body=f
                        else: body=second
                        route.fulfill(status=200, content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(response(body),ensure_ascii=False))
                    else:
                        body=first if len(requests)==1 else second
                        route.fulfill(status=200, content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(response(body),ensure_ascii=False))
                else:
                    # Fonts also blocked: screenshots use installed Japanese fallback fonts.
                    route.abort()
            page.route('**/*',route_request)
            return context,page,requests

        def fill_and_run(page):
            page.locator('#config').evaluate('(el)=>el.open=true')
            page.locator('#apikey').fill('test-placeholder-not-a-real-key')
            page.locator('#question').fill(SNAP['question'])
            page.locator('#reply').fill(SNAP['reply'])
            page.locator('#run').click()
            page.wait_for_function("document.getElementById('status').textContent === '検品が完了しました。'")

        if baseline:
            ctx,page,reqs=page_for('baseline')
            page.set_content(baseline.read_text())
            fill_and_run(page)
            assert page.locator('#marked .f-dantei').count()==3
            assert page.locator('#marked .f-koutei,#marked .f-inyou,#marked .f-mirai').count()==0
            checks.append('元版で同じ模擬応答を表示すると本文3箇所が全て赤になることを再現')
            api_counts['baseline_mock']=len(reqs)
            ctx.close()

        ctx,page,reqs=page_for('main-live-mock')
        page.set_content((ROOT/'index.html').read_text())
        fill_and_run(page)
        assert len(reqs)==2
        assert page.locator('#model').count()==0
        for cls in ['koutei','inyou','mirai']:
            assert page.locator('#marked .f-'+cls).count()==1, cls
        assert page.locator('#marked .f-dantei').count()==0
        assert page.locator('#findings .t-dantei').count()==3
        assert page.locator('#findings .f-tag').count()==6
        assert page.locator('#remeasured').inner_text()==SNAP['result']['remeasured']
        assert '再構成' not in page.locator('#result-note').inner_text()
        for body in reqs:
            prompt=body['contents'][0]['parts'][0]['text']
            assert SNAP['question'] in prompt
            assert SNAP['reply'] in prompt
        checks.append('本体の模擬API経路で緑・藍・琥珀を表示し、赤の指摘3件も下欄に保持')
        checks.append('元の質問と返答を両APIリクエストに保持し、書き換え本文は無変更')
        # Typography / palette stays as supplied.
        for cls,color in [('koutei','rgb(47, 122, 79)'),('inyou','rgb(46, 78, 154)'),('mirai','rgb(156, 100, 18)')]:
            style=page.locator('#marked .f-'+cls).evaluate('(el)=>({color:getComputedStyle(el).textDecorationColor,width:getComputedStyle(el).textDecorationThickness})')
            assert style=={'color':color,'width':'2px'},style
        assert page.locator('#findings s').count()==3
        checks.append('四色のCSSを維持し、本文下線2px・引用の取り消し線を確認')
        page.locator('#marked .seg').nth(1).focus()
        page.keyboard.press('Enter')
        assert page.locator('#marked .seg').nth(1).get_attribute('aria-pressed')=='true'
        page.keyboard.press('Escape')
        assert page.locator('#marked .is-selected').count()==0
        checks.append('小字の区分表示をEnterで選択、Escapeで解除できる')
        page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.__copiedText=text}}})")
        page.locator('#copy').click()
        page.wait_for_function("window.__copiedText !== undefined")
        assert page.evaluate('window.__copiedText')==SNAP['result']['remeasured']
        checks.append('コピー操作は書き換え本文をそのまま渡す（クリップボードを模擬）')
        page.locator('#result').screenshot(path=str(output/'main-result-desktop.png'))
        for width in [320,375,390,480,768,1280]:
            page.set_viewport_size({'width':width,'height':900})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), width
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#result').screenshot(path=str(output/'main-result-mobile.png'))
        checks.append('本体の結果画面は320・375・390・480・768・1280px幅で横はみ出しなし')
        api_counts['main_mock']=len(reqs)
        ctx.close()

        ctx,page,reqs=page_for('main-sample')
        page.set_content((ROOT/'index.html').read_text())
        page.locator('#question').fill('保持する元の質問')
        page.locator('#reply').fill('保持する元の返答')
        page.locator('#sample').click()
        assert page.locator('#question').input_value()==SNAP['question']
        assert page.locator('#reply').input_value()==SNAP['reply']
        for cls in ['koutei','inyou','mirai']:
            assert page.locator('#marked .f-'+cls).count()==1
        assert '生のAPI応答を保存したものではなく' in page.locator('#result-note').inner_text()
        page.locator('#sample').click()
        assert page.locator('#question').input_value()=='保持する元の質問'
        assert page.locator('#reply').input_value()=='保持する元の返答'
        assert not page.locator('#result').is_visible()
        assert len(reqs)==0
        checks.append('本体サンプルはAPIゼロ、元の質問と返答を組で復元できる')
        api_counts['main_sample']=len(reqs)
        ctx.close()

        ctx,page,reqs=page_for('red-only',mode='assertion-only')
        page.set_content((ROOT/'index.html').read_text())
        fill_and_run(page)
        assert page.locator('#marked .f-dantei').count()==3
        assert page.locator('#marked .f-koutei,#marked .f-inyou,#marked .f-mirai').count()==0
        checks.append('APIが赤のみを返すケースは赤のまま。他の指摘を捏造しない')
        api_counts['assertion_only_mock']=len(reqs)
        ctx.close()

        ctx,page,reqs=page_for('error',mode='error')
        page.set_content((ROOT/'index.html').read_text())
        page.locator('#config').evaluate('(el)=>el.open=true')
        page.locator('#apikey').fill('test-placeholder-not-a-real-key')
        page.locator('#question').fill(SNAP['question'])
        page.locator('#reply').fill(SNAP['reply'])
        page.locator('#run').click()
        page.wait_for_function("document.getElementById('status').classList.contains('error')")
        assert page.locator('#run').is_enabled()
        assert page.locator('#sample').is_enabled()
        assert len(reqs)==1
        page.locator('#sample').click()
        assert page.locator('#result').is_visible()
        assert len(reqs)==1
        checks.append('模擬429エラー後に操作へ復帰し、APIなしのサンプルを開ける')
        api_counts['quota_error_mock']=len(reqs)
        ctx.close()

        ctx,page,reqs=page_for('standalone-demo')
        page.set_content((ROOT/'demo/index.html').read_text())
        assert page.locator('#apikey').count()==0
        assert page.locator('textarea').count()==0
        assert page.locator('#run').count()==0
        for cls in ['koutei','inyou','mirai']:
            assert page.locator('#marked .f-'+cls).count()==1
        assert page.locator('#findings .t-dantei').count()==3
        assert page.locator('#remeasured').inner_text()==SNAP['result']['remeasured']
        assert '実行結果の画面から再構成' in page.locator('#result-note').inner_text()
        assert len(reqs)==0
        page.locator('#marked .seg').first.click()  # end introductory selection for screenshot
        page.screenshot(path=str(output/'demo-desktop.png'),full_page=True)
        for width in [320,375,390,480,768,1280]:
            page.set_viewport_size({'width':width,'height':900})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), width
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(output/'demo-mobile.png'),full_page=True)
        checks.append('独立デモはキー欄・入力欄・API呼び出しゼロで同じ3色と全指摘を表示')
        checks.append('独立デモは6画面幅で横はみ出しなし')
        api_counts['standalone_demo']=len(reqs)
        ctx.close()
        assert not page_errors, page_errors
        checks.append('確認した画面・操作でJavaScriptのページ例外なし')
        browser.close()
    return {'passed':len(checks),'checks':checks,'mockApiRequests':api_counts,'liveApiRequests':0,
            'limitations':['API応答とコピー先を模擬。実Geminiの判定精度は検証していない。',
                           'HTMLをメモリに読み込んだChromiumの模擬画面幅で確認。実機のSafari/Chromeは未確認。',
                           '外部フォント通信を遮断し、インストール済み日本語フォントで表示。',
                           'GitHub Pagesの公開サイトは変更・検証していない。']}

if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--chromium',default='/usr/bin/chromium')
    ap.add_argument('--output-dir',type=Path,default=ROOT/'test-artifacts')
    ap.add_argument('--baseline',type=Path,default=None)
    a=ap.parse_args()
    report=run(a.chromium,a.output_dir,a.baseline)
    (a.output_dir/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
