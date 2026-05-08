FUNCTION zfm_write_po_item.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(IV_EBELN) TYPE EBELN
*"  EXPORTING
*"     REFERENCE(ET_PO_ITEMS) TYPE ZCL_PO_ITEM_READER=>TY_PO_ITEMS
*"----------------------------------------------------------------------

  DATA(lo_reader) = NEW zcl_po_item_reader( ).
  et_po_items = lo_reader->get_items( iv_ebeln ).

ENDFUNCTION.
