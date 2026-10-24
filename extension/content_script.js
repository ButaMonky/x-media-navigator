(function () {
    console.log("「X(Twitter)のメディアページに「前のメディアへ」or「次のメディアへ」ボタンを追加」を実行します。");

    const closeButtonSelector = "button[aria-label='閉じる']";
    let lastMediaStatusId = null;
    let mediaObserver = null;

    const interval = 500;
    let globalTileCounter = 1; // 絶対的な番号カウンター
    const tileIndexMap = new Map(); // ステータスIDと番号の対応を保存
    const tileNumberMap = new Map(); // 番号とタイル要素の対応を保存

    let currentTileNumber = 1; // 現在のタイル番号
    let lastAccountName = null; // 最後に確認したアカウント名
    let intervalObserver = null; // タイル処理のsetIntervalを管理
    let isCurrentlyMediaPage = false; // 現在メディアページにいるかどうか

    let previousPath = window.location.pathname; // 初期値を現在のURLパスに設定
    let currentPath = window.location.pathname; // 現在のパスを記録
    /**
     * ページがメディア関連かどうかを判定します。
     * `/media` または `/status/` を含む場合をメディア関連とします。
     */
    function isMediaPage() {
        return window.location.pathname.includes("/media") || window.location.pathname.includes("/status/");
    }

    /**
     * メディアページに入ったときの処理を開始します。
     */
    function onMediaPageLoad() {
        console.log("メディアページに移動しました。スクリプトを開始します。");
    
        resetAllState();
    
        if (!intervalObserver) {
            intervalObserver = setInterval(() => {
                addAbsoluteNumbersToTiles();
                checkAccountChange();
            }, interval);
        }
    
        // メディアページに入った際に現在のアカウント名を設定
        lastAccountName = getCurrentAccountName();
        console.log(`初期アカウント名を設定: ${lastAccountName}`);
    
        isCurrentlyMediaPage = true;
    }
    
    
    /**
     * メディアページから離れた場合の処理を行います。
     */
    function onExitMediaPage() {
        console.log("メディアページから離れました。処理を停止します。");
        resetAllState();
        isCurrentlyMediaPage = false;
    }

    /**
     * スクリプトの全ての状態をリセットします。
     */
    function resetAllState() {
        lastMediaStatusId = null;
        globalTileCounter = 1;
        tileIndexMap.clear();
        tileNumberMap.clear();
        currentTileNumber = 1;

        // 既存のオーバーレイを削除
        document.querySelectorAll('.tile-index-overlay').forEach(el => el.remove());

        // キーボードイベントリスナーを削除
        document.removeEventListener('keydown', handleKeyDown, true);

        // MutationObserverを停止
        if (mediaObserver) {
            mediaObserver.disconnect();
            mediaObserver = null;
        }

        // タイル処理のタイマーを停止
        if (intervalObserver) {
            clearInterval(intervalObserver);
            intervalObserver = null;
        }
    }

    /**
     * 現在のアカウント名を取得します。
     */
    function getCurrentAccountName() {
        const urlMatch = window.location.href.match(/https?:\/\/(x\.com|twitter\.com)\/([^\/]+)/);
        return urlMatch ? urlMatch[2] : null;
    }

    /**
     * アカウントの変更をチェックし、変更があった場合はタイル番号をリセットします。
     */
    function checkAccountChange() {
        const currentAccount = getCurrentAccountName();
        if (currentAccount !== lastAccountName) {
            console.log(`アカウントが変更されました: ${lastAccountName} → ${currentAccount}`);
            resetTileNumbers();
            lastAccountName = currentAccount;
        }
    }

    /**
     * タイル番号をリセットします。
     */
    function resetTileNumbers() {
        // 既存のオーバーレイを削除
        document.querySelectorAll('.tile-index-overlay').forEach(overlay => overlay.remove());
        tileNumberMap.clear();
        tileIndexMap.clear();

        // タイル番号付与を再実行
        addAbsoluteNumbersToTiles();
    }

    /**
     * タイルに絶対番号を追加します。
     */
    function addAbsoluteNumbersToTiles() {
        const tiles = Array.from(document.querySelectorAll("li[role='listitem']"));
        tiles.forEach(tile => {
            // タイルにすでにオーバーレイが付いている場合はスキップ
            if (tile.querySelector('.tile-index-overlay')) return;

            const link = tile.querySelector("a[role='link']");
            const urlMatch = link?.getAttribute('href')?.match(/status\/(\d+)/);

            if (urlMatch) {
                const statusId = urlMatch[1];
                
                // 既にステータスIDに番号が付いている場合は、その番号を再利用
                let tileNumber;
                if (tileIndexMap.has(statusId)) {
                    tileNumber = tileIndexMap.get(statusId);
                } else {
                    // 新しいステータスIDの場合のみ、カウンターを増やして番号を付与
                    tileNumber = globalTileCounter;
                    tileIndexMap.set(statusId, globalTileCounter);
                    tileNumberMap.set(globalTileCounter, tile);
                    globalTileCounter++;
                }

                // オーバーレイ要素を作成してタイルに追加
                const overlay = document.createElement('div');
                overlay.classList.add('tile-index-overlay');
                overlay.textContent = tileNumber;
                tile.appendChild(overlay);

                console.log(`【番号付与】タイル ${tileNumber} に番号を付けました。 (ステータスID: ${statusId})`);
            }
        });
    }

/**
 * メディアビューアにナビゲーションボタンを追加します。
 * - mediaContainerが存在するまで待ってボタンを追加
 */
function checkAndAddButtons() {
    const maxRetries = 10; // 最大リトライ回数
    let attempts = 0;

    function tryAddingButtons() {
        const mediaContainer = document.querySelector("div[data-testid='swipe-to-dismiss']");
        if (mediaContainer) {
            const urlMatch = window.location.href.match(/status\/(\d+)/);
            if (!urlMatch) return;

            const displayedStatusId = urlMatch[1];

            if (displayedStatusId !== lastMediaStatusId || !mediaObserver) {
                lastMediaStatusId = displayedStatusId;

                const existingButtons = mediaContainer.querySelectorAll(".custom-navigation");
                existingButtons.forEach(button => button.remove());

                console.log("メディアビューアが見つかりました。ボタンを追加します。");
                addNavigationButtons(mediaContainer);
                setCurrentTileNumber(displayedStatusId);
                displayCurrentTileNumber();

                observeMediaViewer(mediaContainer);
            }
        } else if (attempts < maxRetries) {
            attempts++;
            setTimeout(tryAddingButtons, 100); // 100msごとに再試行
        } else {
            console.warn("メディアビューアが見つかりませんでした。ボタンの追加を中止します。");
        }
    }

    tryAddingButtons();
}


    /**
     * メディアビューアの変更を監視します。
     */
    function observeMediaViewer(mediaContainer) {
        if (mediaObserver) {
            mediaObserver.disconnect();
        }

        mediaObserver = new MutationObserver(() => {
            const existingButtons = mediaContainer.querySelectorAll(".custom-navigation");
            if (existingButtons.length === 0) {
                console.log("メディアビューアが更新されました。ボタンを再追加します。");
                addNavigationButtons(mediaContainer);
                displayCurrentTileNumber();
            }
        });

        mediaObserver.observe(mediaContainer, { childList: true, subtree: true });

        // メディアビューアが開かれた際にキーボードイベントリスナーを追加
        document.addEventListener('keydown', handleKeyDown, true); // キャプチャリングフェーズで追加
    }

    /**
     * ナビゲーションボタンを追加します。
     */
    function addNavigationButtons(container) {
        const nextButton = document.createElement("div");
        nextButton.innerText = "▶";
        nextButton.classList.add("custom-navigation", "next-button");

        const prevButton = document.createElement("div");
        prevButton.innerText = "◀";
        prevButton.classList.add("custom-navigation", "prev-button");

        container.appendChild(nextButton);
        container.appendChild(prevButton);

        // 次へボタンのクリックイベント
        nextButton.addEventListener("click", (event) => {
            event.stopPropagation();
            if (currentTileNumber < tileNumberMap.size) {
                closeMediaAndThen(() => {
                    navigateToTile(1); // 次のタイルへ移動
                });
            } else {
                // 最後のタイルの場合、メディアビューアを閉じてページをスクロールし、新しいタイルに遷移
                console.log("最後のタイルです。ページをスクロールして新しいタイルを読み込みます。");
                closeMediaAndThen(() => {
                    loadMoreTiles(() => {
                        // 新しいタイルに自動的に遷移
                        navigateToTile(1);
                    });
                });
            }
        });

        // 前へボタンのクリックイベント
        prevButton.addEventListener("click", (event) => {
            event.stopPropagation();
            if (currentTileNumber > 1) {
                closeMediaAndThen(() => {
                    navigateToTile(-1); // 前のタイルへ移動
                });
            }
        });

        // ボタンの初期状態を更新
        updateNavigationButtons();
    }


    /**
     * メディアビューアを閉じてコールバックを実行します。
     */
    function closeMediaAndThen(callback) {
        const closeButton = document.querySelector(closeButtonSelector);
        if (closeButton) {
            closeButton.click();
            // タイムアウトを300msに延長
            setTimeout(() => {
                callback();
            }, 300);
        } else {
            callback();
        }
    }

    /**
     * 現在のタイル番号を設定します。
     */
    function setCurrentTileNumber(statusId) {
        if (tileIndexMap.has(statusId)) {
            currentTileNumber = tileIndexMap.get(statusId);
        }
    }

    /**
     * タイルを移動します。
     */
    function navigateToTile(direction) {
        currentTileNumber += direction;

        if (currentTileNumber < 1) {
            currentTileNumber = 1;
        } else if (currentTileNumber > tileNumberMap.size) {
            currentTileNumber = tileNumberMap.size;
        }

        const targetTile = tileNumberMap.get(currentTileNumber);
        if (targetTile) {
            const link = targetTile.querySelector("a[role='link']");
            if (link) link.click();
            console.log(`移動: ${currentTileNumber} 番のタイルへ`);
            displayCurrentTileNumber();
            updateNavigationButtons(); // ナビゲーションボタンの状態を更新
        }
    }

    /**
     * 現在のタイル番号を表示します。
     */
    function displayCurrentTileNumber() {
        const mediaContainer = document.querySelector("div[data-testid='swipe-to-dismiss']");
        if (!mediaContainer) return;

        let statusText = mediaContainer.querySelector(".current-tile-number");
        if (!statusText) {
            statusText = document.createElement("div");
            statusText.classList.add("current-tile-number");
            // スタイルの設定は外部CSSで行う前提
            mediaContainer.appendChild(statusText);
        }

        statusText.textContent = `現在のタイル番号: ${currentTileNumber}`;
    }

    /**
     * ナビゲーションボタンの有効/無効を更新します。
     */
    function updateNavigationButtons() {
        const mediaContainer = document.querySelector("div[data-testid='swipe-to-dismiss']");
        if (!mediaContainer) return;
    
        const nextButton = mediaContainer.querySelector(".next-button");
        const prevButton = mediaContainer.querySelector(".prev-button");
    
        if (nextButton && prevButton) {
            // 「戻る」ボタンの表示/非表示を制御
            if (currentTileNumber <= 1) {
                prevButton.style.display = 'none';
            } else {
                prevButton.style.display = 'block';
            }
    
            // 「次へ」ボタンの有効/無効は既存のロジックを維持
            if (currentTileNumber >= tileNumberMap.size) {
                nextButton.classList.add('disabled');
            } else {
                nextButton.classList.remove('disabled');
            }
        }
    }

    /**
     * 新しいタイルを読み込むためにページをスクロールします。
     */
    function loadMoreTiles(callback) {
        console.log("ページをスクロールして新しいタイルを読み込みます。");
        // ページの最下部までスクロール
        window.scrollTo({
            top: document.body.scrollHeight,
            behavior: 'smooth'
        });

        // スクロール完了を検知するためにスクロールイベントを監視
        let scrollTimeout;
        function onScroll() {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                window.removeEventListener('scroll', onScroll);
                console.log("新しいタイルが読み込まれました。");
                // 新しいタイルを追加
                addAbsoluteNumbersToTiles();
                updateNavigationButtons();
                if (typeof callback === 'function') {
                    callback();
                }
            }, 300); // スクロール後0.3秒待機（必要に応じて調整）
        }

        window.addEventListener('scroll', onScroll);
    }

    /**
     * キーボードの左右矢印キーでナビゲーションを実行します。
     */
    function handleKeyDown(event) {
        const mediaContainer = document.querySelector("div[data-testid='swipe-to-dismiss']");
        if (!mediaContainer) return; // メディアビューアが開いていない場合は無視

        // デバッグ用にキー情報をログに出力
        console.log(`キーが押されました: key='${event.key}', code='${event.code}'`);

        // 使用するキーを明示的に定義
        const rightKeys = ['ArrowRight', 'Right'];
        const leftKeys = ['ArrowLeft', 'Left'];

        if (rightKeys.includes(event.key) || rightKeys.includes(event.code)) {
            if (currentTileNumber >= tileNumberMap.size) {
                console.log("右矢印キーが押されましたが、既に最後のタイルです。ページをスクロールして新しいタイルを読み込みます。");
                // 最後のタイルで右矢印キーが押された場合、ページをスクロールして新しいタイルを読み込み、自動で次のタイルに遷移
                event.preventDefault(); // デフォルトの動作を防止
                event.stopPropagation();
                event.stopImmediatePropagation();
                closeMediaAndThen(() => {
                    loadMoreTiles(() => {
                        navigateToTile(1); // 新しく読み込まれたタイルに遷移
                    });
                });
                return; // 処理を終了
            }
            // 右矢印キーが押された場合、次のタイルへ移動
            event.preventDefault(); // デフォルトの動作を防止
            event.stopPropagation();
            event.stopImmediatePropagation();
            console.log("右矢印キーが押されました。次のタイルへ移動します。");
            closeMediaAndThen(() => {
                navigateToTile(1); // 次のタイルへ移動
            });
        } else if (leftKeys.includes(event.key) || leftKeys.includes(event.code)) {
            if (currentTileNumber <= 1) {
                console.log("左矢印キーが押されましたが、既に最初のタイルです。");
                return; // 左端の場合は無視
            }
            // 左矢印キーが押された場合、前のタイルへ移動
            event.preventDefault(); // デフォルトの動作を防止
            event.stopPropagation();
            event.stopImmediatePropagation();
            console.log("左矢印キーが押されました。前のタイルへ移動します。");
            closeMediaAndThen(() => {
                navigateToTile(-1); // 前のタイルへ移動
            });
        }
    }


    /**
     * URLの変更を監視し、ページ状態を切り替えます。
    */
    function monitorURLChange() {
        setInterval(() => {
            const newPath = window.location.pathname;
    
            if (newPath !== currentPath) {
                // まず previousPath を currentPath に更新
                previousPath = currentPath; 
                currentPath = newPath;
    
                console.log(`\n🔄 URLが変更されました: ${previousPath} → ${currentPath}`);
                console.log(`🔎 previousPath: ${previousPath}, newPath: ${currentPath}`);
    
                // 条件判定: 前のページが /media で、現在のページが /status/ の場合のみ許可
                const isComingFromMedia = previousPath.includes("/media");
                const isStatusPage = currentPath.includes("/status/");
    
                console.log(`✅ isComingFromMedia: ${isComingFromMedia}, isStatusPage: ${isStatusPage}`);
    
                if (isStatusPage && isComingFromMedia) {
                    console.log("🟢 前のページが /media でした。ボタンを追加します。");
                    checkAndAddButtons();
                } else {
                    console.log("🔴 ボタンは追加しません。");
                }
    
                // ページ状態の切り替え
                const newIsMediaPage = isMediaPage();
                console.log(`🔧 isMediaPage: ${newIsMediaPage}, isCurrentlyMediaPage: ${isCurrentlyMediaPage}`);
    
                if (newIsMediaPage && !isCurrentlyMediaPage) {
                    console.log("🟢 メディアページに入ったので処理を開始します。");
                    onMediaPageLoad();
                } else if (!newIsMediaPage && isCurrentlyMediaPage) {
                    console.log("🔴 メディアページから離れたので処理を停止します。");
                    onExitMediaPage();
                }
    
                console.log(`📝 更新済み: previousPath = ${previousPath}, currentPath = ${currentPath}`);
            }
        }, 100); // 100msごとにチェック
    }
    
    
    // 初期実行
    currentPath = window.location.pathname;
    isCurrentlyMediaPage = isMediaPage();
    if (isCurrentlyMediaPage) {
        onMediaPageLoad();
    }
    monitorURLChange(); // URL変更の監視を開始

})();
