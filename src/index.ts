import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types/types";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { areElementsSame, debounce, yjsToExcalidraw } from "./helpers";
import {
  applyAssetOperations,
  applyElementOperations,
  getDeltaOperationsForAssets,
  getDeltaOperationsForElements,
  LastKnownOrderedElement,
  Operation,
} from "./diff";
export { yjsToExcalidraw };

export class ExcalidrawBinding {
  yElements: Y.Array<Y.Map<any>>;
  yAssets: Y.Map<any> | null = null;
  api: ExcalidrawImperativeAPI;
  awareness?: awarenessProtocol.Awareness;
  undoManager?: Y.UndoManager;

  subscriptions: (() => void)[] = [];
  collaborators: Map<string, Collaborator> = new Map();
  lastKnownElements: LastKnownOrderedElement[] = [];
  lastKnownFileIds: Set<string> = new Set();

  constructor(
    yElements: Y.Array<Y.Map<any>>,
    yAssets: Y.Map<any> | null,
    api: ExcalidrawImperativeAPI,
    awareness?: awarenessProtocol.Awareness,
    undoConfig?: { excalidrawDom: HTMLElement; undoManager: Y.UndoManager }
  ) {
    this.yElements = yElements;
    this.yAssets = yAssets;
    this.api = api;
    this.awareness = awareness;
    const excalidrawDom = undoConfig?.excalidrawDom;
    this.undoManager = undoConfig?.undoManager;

    // Listener for changes made on excalidraw by current user
    this.subscriptions.push(
      this.api.onChange((_, state, files) => {
        // TODO: Excalidraw doesn't delete the asset from the map when the associated item is deleted.
        const elements = this.api.getSceneElements(); // This returns without deleted elements

        // This fires very often even when data is not changed, so keeping a fast procedure to check if anything changed or not
        // Even on move operations, the version property changes so this should work
        let operations: Operation[] = [];
        if (!areElementsSame(this.lastKnownElements, elements)) {
          const res = getDeltaOperationsForElements(
            this.lastKnownElements,
            elements
          );
          operations = res.operations;
          this.lastKnownElements = res.lastKnownElements;
          applyElementOperations(this.yElements, operations, this);
        }

        if (this.yAssets) {
          const res = getDeltaOperationsForAssets(this.lastKnownFileIds, files);
          const assetOperations = res.operations;
          this.lastKnownFileIds = res.lastKnownFileIds;
          if (assetOperations.length > 0) {
            applyAssetOperations(this.yAssets, assetOperations, this);
          }
        }

        if (this.awareness) {
          // update selected awareness
          this.awareness.setLocalStateField(
            "selectedElementIds",
            state.selectedElementIds
          );
        }
      })
    );

    // Listener for changes made on yElements by remote users
    const _remoteElementsChangeHandler = (
      event: Array<Y.YEvent<any>>,
      txn: Y.Transaction
    ) => {
      if (txn.origin === this) {
        return;
      }

      // Get changed elements from events
      const changedElementIds = new Set(
        event.flatMap((e) => {
          if (e instanceof Y.YMapEvent) {
            return [e.target.get("el").id as string];
          }
          return [];
        })
      );

      const remoteElements = yjsToExcalidraw(this.yElements);
      const elements = remoteElements.map((el) => {
        if (changedElementIds.has(el.id)) {
          return el;
        }
        return (
          this.api
            .getSceneElements()
            .find((existingEl) => existingEl.id === el.id) || el
        );
      });

      this.lastKnownElements = this.yElements
        .toArray()
        .map((x) => ({
          id: x.get("el").id,
          version: x.get("el").version,
          pos: x.get("pos"),
        }))
        .sort((a, b) => {
          const key1 = a.pos;
          const key2 = b.pos;
          return key1 > key2 ? 1 : key1 < key2 ? -1 : 0;
        });
      this.api.updateScene({ elements });
    };
    this.yElements.observeDeep(_remoteElementsChangeHandler);
    this.subscriptions.push(() =>
      this.yElements.unobserveDeep(_remoteElementsChangeHandler)
    );

    // Listener for changes made on yAssets by remote users
    const _remoteFilesChangeHandler = (
      events: Y.YMapEvent<any>,
      txn: Y.Transaction
    ) => {
      if (txn.origin === this) {
        return;
      }

      const addedFiles = [...events.keysChanged].map(
        (key) => this.yAssets!.get(key) as BinaryFileData
      );
      this.api.addFiles(addedFiles);
    };
    if (this.yAssets) {
      this.yAssets.observe(_remoteFilesChangeHandler); // only observe and not observe deep as assets are only added/deleted not updated
      this.subscriptions.push(() => {
        this.yAssets.unobserve(_remoteFilesChangeHandler);
      });
    }

    if (this.awareness) {
      // Listener for awareness changes made by remote users
      const _remoteAwarenessChangeHandler = ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const states = this.awareness.getStates();

        const collaborators = new Map(this.collaborators);
        const update = [...added, ...updated];
        for (const id of update) {
          const state = states.get(id);
          if (!state) {
            continue;
          }

          collaborators.set(id.toString(), {
            pointer: state.pointer,
            button: state.button,
            selectedElementIds: state.selectedElementIds,
            username: state.user?.name,
            color: state.user?.color,
            avatarUrl: state.user?.avatarUrl,
            userState: state.user?.state,
          });
        }
        for (const id of removed) {
          collaborators.delete(id.toString());
        }
        collaborators.delete(this.awareness.clientID.toString());
        this.api.updateScene({ collaborators });
        this.collaborators = collaborators;
      };
      this.awareness.on("change", _remoteAwarenessChangeHandler);
      this.subscriptions.push(() => {
        this.awareness.off("change", _remoteAwarenessChangeHandler);
      });
    }

    if (this.undoManager) {
      this.setupUndoRedo(excalidrawDom);
    }

    // init elements
    const initialValue = yjsToExcalidraw(this.yElements);
    this.lastKnownElements = this.yElements
      .toArray()
      .map((x) => ({
        id: x.get("el").id,
        version: x.get("el").version,
        pos: x.get("pos"),
      }))
      .sort((a, b) => {
        const key1 = a.pos;
        const key2 = b.pos;
        return key1 > key2 ? 1 : key1 < key2 ? -1 : 0;
      });
    this.api.updateScene({ elements: initialValue });

    // init assets
    if (this.yAssets) {
      this.api.addFiles(
        [...this.yAssets.keys()].map(
          (key) => this.yAssets.get(key) as BinaryFileData
        )
      );
    }

    // init collaborators
    const collaborators = new Map();
    if (this.awareness) {
      for (let id of this.awareness!.getStates().keys()) {
        const state = this.awareness!.getStates().get(id);
        collaborators.set(id.toString(), {
          pointer: state.pointer,
          button: state.button,
          selectedElementIds: state.selectedElementIds,
          username: state.user?.name,
          color: state.user?.color,
          avatarUrl: state.user?.avatarUrl,
          userState: state.user?.state,
        });
      }
    }

    this.api.updateScene({ collaborators });
    this.collaborators = collaborators;
  }

  public onPointerUpdate = (payload: {
    pointer: {
      x: number;
      y: number;
      tool: "pointer" | "laser";
    };
    button: "down" | "up";
  }) => {
    if (this.awareness) {
      this.awareness.setLocalStateField("pointer", payload.pointer);
      this.awareness.setLocalStateField("button", payload.button);
    }
  };

  private setupUndoRedo(excalidrawDom: HTMLElement) {
    this.undoManager.addTrackedOrigin(this);
    this.subscriptions.push(() => this.undoManager.removeTrackedOrigin(this));

    // listen for undo/redo keys
    const _keyPressHandler = (event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key?.toLocaleLowerCase() === "z"
      ) {
        event.stopPropagation();
        this.undoManager.redo();
      } else if (event.ctrlKey && event.key?.toLocaleLowerCase() === "z") {
        event.stopPropagation();
        this.undoManager.undo();
      }
    };
    excalidrawDom.addEventListener("keydown", _keyPressHandler, {
      capture: true,
    });
    this.subscriptions.push(() =>
      excalidrawDom?.removeEventListener("keydown", _keyPressHandler, {
        capture: true,
      })
    );

    // hijack the undo/redo buttons
    // these get destroyed/recreated when view changes from desktop->mobile, so the listeners need to be added again
    let undoButton: HTMLButtonElement | null;
    let redoButton: HTMLButtonElement | null;

    const _undoBtnHandler = (event) => {
      event.stopImmediatePropagation();
      this.undoManager.undo();
    };
    const _redoBtnHandler = (event) => {
      event.stopImmediatePropagation();
      this.undoManager.redo();
    };

    const _resizeListener = () => {
      if (!undoButton || !undoButton.isConnected) {
        undoButton?.removeEventListener("click", _undoBtnHandler);
        undoButton = excalidrawDom.querySelector('[aria-label="Undo"]'); // Assuming new undoButton is added to dom by now
        undoButton.addEventListener("click", _undoBtnHandler);
      }

      if (!redoButton || !redoButton.isConnected) {
        redoButton?.removeEventListener("click", _redoBtnHandler);
        redoButton = excalidrawDom.querySelector('[aria-label="Redo"]'); // Assuming new redoButton is added to dom by now
        redoButton.addEventListener("click", _redoBtnHandler);
      }
    };

    const ro = new ResizeObserver(debounce(_resizeListener, 100));
    ro.observe(excalidrawDom);

    // Call resize on init
    _resizeListener();

    this.subscriptions.push(() =>
      undoButton?.removeEventListener("click", _undoBtnHandler)
    );
    this.subscriptions.push(() =>
      redoButton?.removeEventListener("click", _redoBtnHandler)
    );
    this.subscriptions.push(() => ro.disconnect());
  }

  destroy() {
    for (const s of this.subscriptions) {
      s();
    }
  }
}
