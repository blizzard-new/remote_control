#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

// Report only the focused control's editability. Never read its contents.
extern "C" __declspec(dllexport) BOOL __stdcall IsEditableFocus() {
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return FALSE;
    BOOL editable = FALSE;
    {
        ComPtr<IUIAutomation> automation;
        ComPtr<IUIAutomationElement> focused;
        if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                                       IID_PPV_ARGS(&automation))) &&
            SUCCEEDED(automation->GetFocusedElement(&focused)) && focused) {
            CONTROLTYPEID type{};
            focused->get_CurrentControlType(&type);
            ComPtr<IUIAutomationValuePattern> value;
            if (SUCCEEDED(focused->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value) {
                BOOL readonly = TRUE;
                if (SUCCEEDED(value->get_CurrentIsReadOnly(&readonly))) editable = !readonly;
            } else if (type == UIA_EditControlTypeId) editable = TRUE;
            else {
                VARIANT available{};
                if (SUCCEEDED(focused->GetCurrentPropertyValue(UIA_IsTextEditPatternAvailablePropertyId,&available)))
                    editable = available.vt == VT_BOOL && available.boolVal == VARIANT_TRUE;
                VariantClear(&available);
            }
        }
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
    return editable;
}
