export THEOS_PACKAGE_SCHEME = rootless

TARGET := iphone:clang:latest:15.0
ARCHS := arm64

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = AzotaQuizTutor
AzotaQuizTutor_FILES = Tweak.xm
AzotaQuizTutor_FRAMEWORKS = UIKit WebKit Foundation Security
AzotaQuizTutor_CFLAGS = -fobjc-arc -Wno-deprecated-declarations
AzotaQuizTutor_INSTALL_PATH = /Library/MobileSubstrate/DynamicLibraries

include $(THEOS_MAKE_PATH)/tweak.mk
