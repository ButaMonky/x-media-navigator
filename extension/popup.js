'use strict';
// The content script saves only generic health codes; no browsing history.
const labels={
  CONTROLS_LAYOUT_OK:['操作ボタンを配置しました','ボタンがまだ見えない場合、X側のレイヤーとの重なりや他の拡張との干渉が考えられます。'],
  CONTROLS_HIDDEN_GEOMETRY:['表示位置を確定できません','画像領域が小さすぎるか、Xの新しい配置に未対応です。'],
  CONTROLS_STYLE_HIDDEN:['操作ボタンがCSSで非表示です','他のスタイルとの競合が疑われます。'],
  CONTROLS_NOT_MOUNTED:['操作ボタンを取り付けられません','Xのビューアは検出しましたが、操作UIの作成が完了していません。'],
  VIEWER_READY:['画像ビューアを認識しています','画像・投稿移動用のUIを初期化できています。'],
  MEDIA_INDEX_READY:['メディア一覧を認識しています','画像をクリックすると移動ボタンが表示されます。'],
  MEDIA_GRID_NOT_FOUND:['メディア一覧が未検出です','Xの表示構造が変わったか、一覧がまだ読み込まれていません。'],
  VIEWER_NOT_FOUND:['画像ビューアが未検出です','Xの新しい表示形式に拡張機能が追従できていない可能性があります。'],
  OPEN_MEDIA_TAB_FIRST:['メディアタブを開いてください','直接投稿URLを開いた場合、一覧の順序を確定できません。'],
  INITIALIZATION_ERROR:['初期化時のエラーを検出','Chromeの拡張機能管理にあるエラー表示をご確認ください。'],
  STARTING:['起動中','Xのページが読み込まれるまでお待ちください。']
};
async function refreshHealth(){
  const status=document.getElementById('status');
  const description=document.getElementById('description');
  const code=document.getElementById('code');
  try{
    const {xmnHealth}=await chrome.storage.local.get('xmnHealth');
    const valid=xmnHealth&&typeof xmnHealth==='object'&&
      typeof xmnHealth.code==='string'&&
      Object.prototype.hasOwnProperty.call(labels,xmnHealth.code);
    const fresh=valid&&Number.isFinite(xmnHealth.updatedAt)&&
      Date.now()-xmnHealth.updatedAt>=0&&Date.now()-xmnHealth.updatedAt<180000;
    const result=fresh?labels[xmnHealth.code]:
      ['Xでの起動が確認できません','Xのメディアタブを再読み込みしてください。再読み込み後も変化しなければ拡張機能が無効化されている可能性があります。'];
    status.textContent=result[0];
    description.textContent=result[1];
    code.textContent=fresh?'診断コード：'+xmnHealth.code:'診断コード：INJECTION_UNCONFIRMED';
  }catch{
    status.textContent='診断情報を読み取れません';
    description.textContent='Chromeの拡張機能エラー画面をご確認ください。';
    code.textContent='診断コード：STORAGE_UNAVAILABLE';
  }
}
document.getElementById('version').textContent='v'+chrome.runtime.getManifest().version;
document.getElementById('refresh').addEventListener('click',refreshHealth);
void refreshHealth();